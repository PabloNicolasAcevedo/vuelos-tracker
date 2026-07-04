const { appendRows } = require("./lib/store");
const { buildSummaries } = require("./lib/summary");
const { sendSummaryEmails } = require("./lib/email");

const routes = require("./config/routes.json");

const SCRAPERS = {
  gol: () => require("./scrapers/gol"),
  // aerolineas, latam, 123milhas, maxmilhas, despegar, googleflights: pendientes (ver README)
};

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
        stayNights: route.stayNights,
      });
    }
  }
  return bySite;
}

async function main() {
  const bySite = buildRoutePlan();
  const allResults = [];

  for (const [site, siteRoutes] of Object.entries(bySite)) {
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
