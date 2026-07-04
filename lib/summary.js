const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { CSV_PATH, writeCsvFile } = require("./store");

const routes = require("../config/routes.json");

const SITE_ORDER = ["gol", "aerolineas", "latam", "123milhas", "maxmilhas", "despegar", "googleflights"];

function loadPriceRows() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const content = fs.readFileSync(CSV_PATH, "utf8");
  // record_delimiter must be explicit: csv-parse's auto-detection gets
  // confused on this file (many rows end in an empty trailing field) and
  // merges dozens of rows into one, throwing CSV_RECORD_INCONSISTENT_COLUMNS.
  return parse(content, { columns: true, skip_empty_lines: true, record_delimiter: "\n" });
}

function routesById() {
  const map = {};
  for (const route of routes) map[route.id] = route;
  return map;
}

// Builds one pivoted, human-friendly summary for a given person: one row per
// route + date(s), with the most recent known price per site side by side,
// plus the current best price/site so it's obvious what to book.
function buildSummaryForPerson(person, oneWay) {
  const byId = routesById();
  const relevantRows = loadPriceRows().filter((row) => {
    const route = byId[row.route_id];
    return route && route.person === person && row.price !== "";
  });

  // Keep only the most recent scrape per (route, dates, site) combination.
  const latestBySiteAndDates = new Map();
  for (const row of relevantRows) {
    const key = [row.route_id, row.depart_date, row.return_date, row.site].join("|");
    const prev = latestBySiteAndDates.get(key);
    if (!prev || row.scraped_at > prev.scraped_at) latestBySiteAndDates.set(key, row);
  }

  // Group those latest rows by (route, dates) so each trip option becomes one row.
  const groups = new Map();
  for (const row of latestBySiteAndDates.values()) {
    const key = [row.route_id, row.depart_date, row.return_date].join("|");
    if (!groups.has(key)) {
      const route = byId[row.route_id];
      groups.set(key, {
        route_id: row.route_id,
        ruta: route.label,
        origen: row.origin,
        destino: row.destination,
        fecha_salida: row.depart_date,
        fecha_vuelta: row.return_date,
        prices: {},
        ultima_actualizacion: row.scraped_at,
      });
    }
    const group = groups.get(key);
    group.prices[row.site] = Number(row.price);
    if (row.scraped_at > group.ultima_actualizacion) group.ultima_actualizacion = row.scraped_at;
  }

  const sitesSeen = new Set(relevantRows.map((row) => row.site));
  const orderedSites = [
    ...SITE_ORDER.filter((s) => sitesSeen.has(s)),
    ...[...sitesSeen].filter((s) => !SITE_ORDER.includes(s)).sort(),
  ];

  const header = [
    "ruta",
    "origen",
    "destino",
    "fecha_salida",
    ...(oneWay ? [] : ["fecha_vuelta"]),
    ...orderedSites.map((s) => `precio_${s}`),
    "mejor_precio",
    "mejor_sitio",
    "ultima_actualizacion",
  ];

  const rows = [...groups.values()]
    .sort((a, b) => (a.route_id + a.fecha_salida).localeCompare(b.route_id + b.fecha_salida))
    .map((group) => {
      let bestSite = "";
      let bestPrice = Infinity;
      for (const site of orderedSites) {
        const price = group.prices[site];
        if (price != null && price < bestPrice) {
          bestPrice = price;
          bestSite = site;
        }
      }
      const row = {
        ruta: group.ruta,
        origen: group.origen,
        destino: group.destino,
        fecha_salida: group.fecha_salida,
      };
      if (!oneWay) row.fecha_vuelta = group.fecha_vuelta;
      for (const site of orderedSites) row[`precio_${site}`] = group.prices[site] ?? "";
      row.mejor_precio = bestPrice === Infinity ? "" : bestPrice;
      row.mejor_sitio = bestSite;
      row.ultima_actualizacion = group.ultima_actualizacion;
      return row;
    });

  return { header, rows };
}

function buildSummaries() {
  const dataDir = path.join(__dirname, "..", "data");

  const pablo = buildSummaryForPerson("pablo", true);
  writeCsvFile(path.join(dataDir, "resumen-pablo.csv"), pablo.header, pablo.rows);

  const david = buildSummaryForPerson("david", false);
  writeCsvFile(path.join(dataDir, "resumen-david.csv"), david.header, david.rows);
}

module.exports = { buildSummaries };
