const fs = require("fs");
const path = require("path");
const { loadRawPriceRows, computeHistoryStats, keyOf } = require("./history");
const { buildBookingLink } = require("./links");
const { getRate } = require("./exchangeRate");

const routes = require("../config/routes.json");

const DATA_DIR = path.join(__dirname, "..", "docs", "data");

// Google Flights stores the SerpApi-provided URL inside its notes JSON;
// Gol/Aerolineas links are rebuilt from the route params instead.
function linkFor(site, row) {
  if (site === "googleflights") {
    try {
      return JSON.parse(row.latestNotes || "{}").link || null;
    } catch {
      return null;
    }
  }
  return buildBookingLink(site, {
    origin: row.origin,
    destination: row.destination,
    departISO: row.depart_date,
    returnISO: row.return_date || null,
  });
}

// Collapses a key's full scrape history to one point per day (the daily
// minimum), so route JSONs grow by one point per day per series regardless
// of how many scrape runs happen each day.
function dailyMinPoints(history) {
  const byDay = new Map();
  for (const entry of history) {
    const day = entry.scraped_at.slice(0, 10);
    const prev = byDay.get(day);
    if (prev == null || entry.price < prev) byDay.set(day, entry.price);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// Builds the static-site dataset under docs/data/: a lightweight index.json
// (route list + exchange rate) plus one JSON per route with current prices,
// per-site stats and the daily-min price history the charts are drawn from.
async function buildSiteData() {
  const rows = loadRawPriceRows();
  const stats = computeHistoryStats(rows);
  const today = new Date().toISOString().slice(0, 10);
  const generatedAt = new Date().toISOString();

  fs.mkdirSync(path.join(DATA_DIR, "routes"), { recursive: true });

  const indexRoutes = [];
  for (const route of routes) {
    // Same purchasability rule as summary.js: only dates that are not in the
    // past and not before the route's minimum departure date (fromDate).
    const routeRows = rows.filter(
      (row) =>
        row.route_id === route.id &&
        row.price !== "" &&
        row.price != null &&
        row.depart_date >= today &&
        (!route.fromDate || row.depart_date >= route.fromDate)
    );
    if (!routeRows.length) continue;

    // One option per (depart, return); one stats key per option+site.
    const optionKeys = new Map();
    for (const row of routeRows) {
      const optKey = `${row.depart_date}|${row.return_date || ""}`;
      if (!optionKeys.has(optKey)) optionKeys.set(optKey, { row, sites: new Set() });
      optionKeys.get(optKey).sites.add(row.site);
    }

    const sitesSeen = new Set();
    const options = [...optionKeys.values()]
      .sort((a, b) => a.row.depart_date.localeCompare(b.row.depart_date))
      .map(({ row, sites }) => {
        const option = {
          depart: row.depart_date,
          return: row.return_date || null,
          current: {},
          best: null,
          history: {},
        };
        for (const site of [...sites].sort()) {
          const st = stats.get(keyOf({ ...row, site }));
          if (!st) continue;
          sitesSeen.add(site);
          const latestScrapedAt = st.history[st.history.length - 1].scraped_at;
          option.current[site] = {
            price: st.latestPrice,
            currency: st.currency,
            scraped_at: latestScrapedAt,
            link: linkFor(site, { ...row, latestNotes: st.latestNotes }),
            is_historical_min: st.latestPrice <= st.min,
          };
          option.history[site] = {
            currency: st.currency,
            min: st.min,
            avg: Math.round(st.avg),
            points: dailyMinPoints(st.history),
          };
          if (!option.best || st.latestPrice < option.best.price) {
            option.best = { site, price: st.latestPrice, currency: st.currency };
          }
        }
        return option;
      })
      .filter((option) => option.best);

    if (!options.length) continue;

    const routeData = {
      route_id: route.id,
      label: route.label,
      origin: route.origin,
      destination: route.destination,
      tripType: route.tripType || "roundtrip",
      stayNights: route.stayNights || null,
      updated_at: generatedAt,
      options,
    };
    fs.writeFileSync(path.join(DATA_DIR, "routes", `${route.id}.json`), JSON.stringify(routeData));

    indexRoutes.push({
      id: route.id,
      label: route.label,
      origin: route.origin,
      destination: route.destination,
      tripType: route.tripType || "roundtrip",
      stayNights: route.stayNights || null,
      sites: [...sitesSeen].sort(),
      options: options.length,
    });
  }

  const index = {
    generated_at: generatedAt,
    brl_ars_rate: await getRate("BRL", "ARS"),
    routes: indexRoutes,
  };
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify(index));
  return index;
}

module.exports = { buildSiteData };
