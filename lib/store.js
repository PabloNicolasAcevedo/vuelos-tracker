const fs = require("fs");
const path = require("path");

// Legacy single-file history (pre-partitioning); kept only so old checkouts
// with data/prices.csv still contribute to the history until migrated.
const CSV_PATH = path.join(__dirname, "..", "data", "prices.csv");
// Current history lives partitioned by scrape month: data/prices/YYYY-MM.csv.
// A single append-only file would hit GitHub's 100MB per-file limit within
// months at the current scrape volume.
const PRICES_DIR = path.join(__dirname, "..", "data", "prices");
const HEADER = [
  "scraped_at",
  "site",
  "route_id",
  "origin",
  "destination",
  "depart_date",
  "return_date",
  "price",
  "currency",
  "notes",
];

function partitionPathFor(month) {
  return path.join(PRICES_DIR, `${month}.csv`);
}

function ensureHeader(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, HEADER.join(",") + "\n");
  }
}

// All history files, oldest first: the legacy prices.csv (if still present)
// followed by the monthly partitions.
function listPriceFiles() {
  const files = [];
  if (fs.existsSync(CSV_PATH)) files.push(CSV_PATH);
  if (fs.existsSync(PRICES_DIR)) {
    const partitions = fs
      .readdirSync(PRICES_DIR)
      .filter((name) => /^\d{4}-\d{2}\.csv$/.test(name))
      .sort();
    for (const name of partitions) files.push(path.join(PRICES_DIR, name));
  }
  return files;
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendRows(rows) {
  // Rows from one run can straddle a month boundary, so bucket by the
  // scrape month of each row rather than assuming a single partition.
  const byMonth = new Map();
  for (const row of rows) {
    const month = String(row.scraped_at).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }
  for (const [month, monthRows] of byMonth) {
    const filePath = partitionPathFor(month);
    ensureHeader(filePath);
    const lines = monthRows.map((row) => HEADER.map((key) => escapeCsv(row[key])).join(","));
    fs.appendFileSync(filePath, lines.join("\n") + "\n");
  }
}

// Overwrites filePath with a fresh CSV (used for regenerated summary files,
// as opposed to appendRows' append-only history log).
function writeCsvFile(filePath, header, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => escapeCsv(row[key])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

module.exports = { appendRows, writeCsvFile, listPriceFiles, CSV_PATH, PRICES_DIR, HEADER };
