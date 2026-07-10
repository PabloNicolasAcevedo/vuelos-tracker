const { appendRows } = require("./lib/store");
const { buildSummaries } = require("./lib/summary");
const { sendSummaryEmails } = require("./lib/email");
const { loadRawPriceRows } = require("./lib/history");

const routes = require("./config/routes.json");

const SCRAPERS = {
  gol: () => require("./scrapers/gol"),
  aerolineas: () => require("./scrapers/aerolineas"),
  googleflights: () => require("./scrapers/googleflights"),
  // latam, 123milhas, maxmilhas, despegar: pendientes (ver README)
};

// Google Flights (via SerpApi) has a 250 free-searches/month budget, so it
// only runs once a day -- not on every cron trigger like Gol/Aerolineas --
// and reuses that single daily snapshot across the day's other runs/emails.
function hasRunGoogleFlightsToday() {
  const today = new Date().toISOString().slice(0, 10);
  return loadRawPriceRows().some((row) => row.site === "googleflights" && row.scraped_at.startsWith(today));
}

// Both trip types scan every day of the target months (the calendar already
// returns full months in one request); roundtrip pairs each day with a fixed
// stayNights so coverage stays complete without exploding date combinations.
function buildRoutePlan() {
  const bySite = {};
  for (const route of routes) {
    const tripType = route.tripType || "roundtrip";
    for (const site of route.sites) {
      if (!SCRAPERS[site]) continue; // scraper not implemented yet
      bySite[site] = bySite[site] || [];
      bySite[site].push({
        id: route.id,
        origin: route.origin,
        destination: route.destination,
        tripType,
        months: route.months,
        fromDate: route.fromDate,
        stayNights: route.stayNights,
      });
    }
  }
  return bySite;
}

async function main() {
  const bySite = buildRoutePlan();
  const allResults = [];

  const skipGoogleFlights = hasRunGoogleFlightsToday();

  // Google Flights goes first (when it needs to run at all) so its once-a-day
  // snapshot is already in prices.csv in time for the first email of the day,
  // instead of only showing up from the second run onward.
  const sitesInOrder = Object.keys(bySite).sort((a, b) => (a === "googleflights" ? -1 : b === "googleflights" ? 1 : 0));

  for (const site of sitesInOrder) {
    const siteRoutes = bySite[site];
    if (site === "googleflights" && skipGoogleFlights) {
      console.log("--- Google Flights ya corrió hoy, se salta (se reutiliza el snapshot del día) ---");
      continue;
    }
    console.log(`--- Scraping ${site} (${siteRoutes.length} rutas) ---`);
    try {
      const scraper = SCRAPERS[site]();
      const results = await scraper.run(siteRoutes);
      console.log(`${site}: ${results.length} filas`);
      allResults.push(...results);
    } catch (err) {
      console.error(`${site} failed:`, err.message);
    }
  }

  if (allResults.length) {
    appendRows(allResults);
    console.log(`Guardadas ${allResults.length} filas en data/prices.csv`);
  } else {
    console.log("Sin resultados en esta corrida.");
  }

  buildSummaries();
  console.log("Regenerados data/resumen-pablo.csv y data/resumen-david.csv");

  try {
    await sendSummaryEmails();
  } catch (err) {
    console.error("Error enviando emails:", err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
