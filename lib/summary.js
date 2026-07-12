const path = require("path");
const { writeCsvFile } = require("./store");
const { loadRawPriceRows } = require("./history");
const { isoToDDMMYYYY } = require("./dates");

const routes = require("../config/routes.json");

const SITE_ORDER = ["gol", "aerolineas", "latam", "123milhas", "maxmilhas", "despegar", "googleflights"];

const CURRENCY_LOCALES = { BRL: "pt-BR", ARS: "es-AR", USD: "en-US" };

function formatCurrency(value, currency) {
  if (value === "" || value == null || !currency) return "";
  const locale = CURRENCY_LOCALES[currency] || "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
}

function formatTimestamp(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function routesById() {
  const map = {};
  for (const route of routes) map[route.id] = route;
  return map;
}

// Builds one pivoted, human-friendly summary for a given person: one row per
// route + date(s), with the most recent known price per site side by side,
// plus the current best price/site so it's obvious what to book. Dates and
// prices are formatted for reading (DD/MM/YYYY, "R$ 1.250,23"), not for
// further spreadsheet math.
function buildSummaryForPerson(person, oneWay) {
  const byId = routesById();
  const today = new Date().toISOString().slice(0, 10);
  const relevantRows = loadRawPriceRows().filter((row) => {
    const route = byId[row.route_id];
    // googleflights is intentionally excluded from this pivot: it's a once-a-day
    // aggregator snapshot (see index.js), shown as its own labeled section in
    // the email instead of silently competing for "mejor_sitio" against the
    // live per-run Gol/Aerolineas scrapes.
    if (!route || route.person !== person || row.price === "" || row.site === "googleflights") return false;
    // Only include dates the person can still buy: not in the past, and not
    // before the route's minimum departure date (fromDate). Historical prices
    // for those dates stay in prices.csv for stats but shouldn't appear in
    // the actionable summary the email is built from.
    if (row.depart_date < today) return false;
    if (route.fromDate && row.depart_date < route.fromDate) return false;
    if (route.toDate && row.depart_date > route.toDate) return false;
    return true;
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
        currencies: {},
        ultima_actualizacion: row.scraped_at,
      });
    }
    const group = groups.get(key);
    group.prices[row.site] = Number(row.price);
    group.currencies[row.site] = row.currency;
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
        fecha_salida: isoToDDMMYYYY(group.fecha_salida),
      };
      if (!oneWay) row.fecha_vuelta = isoToDDMMYYYY(group.fecha_vuelta);
      for (const site of orderedSites) {
        row[`precio_${site}`] = formatCurrency(group.prices[site], group.currencies[site]);
      }
      row.mejor_precio = bestSite ? formatCurrency(bestPrice, group.currencies[bestSite]) : "";
      row.mejor_sitio = bestSite;
      row.ultima_actualizacion = formatTimestamp(group.ultima_actualizacion);
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

  const jessica = buildSummaryForPerson("jessica", true);
  writeCsvFile(path.join(dataDir, "resumen-jessica.csv"), jessica.header, jessica.rows);
}

module.exports = { buildSummaries };
