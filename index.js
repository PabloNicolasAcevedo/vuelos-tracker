const fs = require("fs");
const path = require("path");
const { datePairFromConfig } = require("./lib/dates");
const { appendRows } = require("./lib/store");

const routes = require("./config/routes.json");
const searchDates = require("./config/searchDates.json");

const SCRAPERS = {
  gol: () => require("./scrapers/gol"),
  // 123milhas, maxmilhas, aerolineas, despegar, googleflights: pendientes (ver README)
};

function buildRoutePlan() {
  const bySite = {};
  for (const route of routes) {
    const datePairs = route.months.flatMap((month) =>
      (searchDates[month] || []).map(({ departDay, nights }) => {
        const pair = datePairFromConfig(month, departDay, nights);
        return { departISO: pair.departISO, returnISO: pair.returnISO };
      })
    );
    for (const site of route.sites) {
      if (!SCRAPERS[site]) continue; // scraper not implemented yet
      bySite[site] = bySite[site] || [];
      bySite[site].push({ id: route.id, origin: route.origin, destination: route.destination, datePairs });
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
