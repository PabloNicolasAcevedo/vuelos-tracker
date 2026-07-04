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

module.exports = { appendRows, CSV_PATH };
