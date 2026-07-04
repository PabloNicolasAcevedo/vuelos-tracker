const { datePairFromConfig } = require("./lib/dates");
const { appendRows } = require("./lib/store");
const { buildSummaries } = require("./lib/summary");

const routes = require("./config/routes.json");
const searchDates = require("./config/searchDates.json");

const SCRAPERS = {
  gol: () => require("./scrapers/gol"),
  // aerolineas, latam, 123milhas, maxmilhas, despegar, googleflights: pendientes (ver README)
};

function buildRoutePlan() {
  const bySite = {};
  for (const route of routes) {
    const tripType = route.tripType || "roundtrip";
    const datePairs =
      tripType === "roundtrip"
        ? route.months.flatMap((month) =>
            (searchDates[month] || []).map(({ departDay, nights }) => {
              const pair = datePairFromConfig(month, departDay, nights);
              return { departISO: pair.departISO, returnISO: pair.returnISO };
            })
          )
        : [];
    for (const site of route.sites) {
      if (!SCRAPERS[site]) continue; // scraper not implemented yet
      bySite[site] = bySite[site] || [];
      bySite[site].push({
        id: route.id,
        origin: route.origin,
        destination: route.destination,
        tripType,
        months: route.months,
        datePairs,
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
