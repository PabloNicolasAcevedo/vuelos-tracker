const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "..", "data", "prices.csv");
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

function ensureHeader() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
    fs.writeFileSync(CSV_PATH, HEADER.join(",") + "\n");
  }
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendRows(rows) {
  ensureHeader();
  const lines = rows.map((row) => HEADER.map((key) => escapeCsv(row[key])).join(","));
  fs.appendFileSync(CSV_PATH, lines.join("\n") + "\n");
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

module.exports = { appendRows, writeCsvFile, CSV_PATH };
