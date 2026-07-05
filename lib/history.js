const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { CSV_PATH } = require("./store");

function keyOf(row) {
  return [row.route_id, row.depart_date, row.return_date, row.site].join("|");
}

function loadRawPriceRows() {
  if (!fs.existsSync(CSV_PATH)) return [];
  // git's core.autocrlf can check this file out with \r\n while our own
  // appendRows always writes plain \n, leaving a mix that makes csv-parse
  // attach a stray \r to the last header name ("notes\r") for every row.
  // Normalizing first sidesteps that regardless of which line ending any
  // given line happens to have.
  const content = fs.readFileSync(CSV_PATH, "utf8").replace(/\r\n/g, "\n");
  return parse(content, { columns: true, skip_empty_lines: true, record_delimiter: "\n" });
}

// Groups all historical scrapes by (route_id, depart_date, return_date, site) and,
// for each group, derives the stats needed for "new low" badges and
// last-update deltas: full price history sorted by time, historical min/avg,
// the latest price, the one before it, and whether the latest is a new low.
function computeHistoryStats(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (row.price === "" || row.price == null) continue;
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ scraped_at: row.scraped_at, price: Number(row.price), currency: row.currency, notes: row.notes });
  }

  const stats = new Map();
  for (const [key, entries] of byKey) {
    const sorted = [...entries].sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
    const prices = sorted.map((e) => e.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const latest = sorted[sorted.length - 1];
    const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;

    // Compared against everything *before* the latest scrape, not the min
    // including it, so a lone first-ever scrape isn't reported as a "new low".
    const priorPrices = prices.slice(0, -1);
    const minBeforeLatest = priorPrices.length ? Math.min(...priorPrices) : null;

    stats.set(key, {
      history: sorted,
      min,
      max,
      avg,
      currency: latest.currency,
      latestPrice: latest.price,
      latestNotes: latest.notes,
      previousPrice: previous ? previous.price : null,
      deltaFromPrevious: previous ? latest.price - previous.price : null,
      isNewHistoricalMin: minBeforeLatest != null && latest.price < minBeforeLatest,
      isTiedWithMin: minBeforeLatest != null && latest.price === minBeforeLatest,
    });
  }
  return stats;
}

// Convenience: build stats straight from the on-disk history CSV.
function getHistoryStats() {
  return computeHistoryStats(loadRawPriceRows());
}

function statsForRow(stats, row) {
  return stats.get(keyOf(row)) || null;
}

module.exports = { computeHistoryStats, getHistoryStats, statsForRow, keyOf, loadRawPriceRows };
