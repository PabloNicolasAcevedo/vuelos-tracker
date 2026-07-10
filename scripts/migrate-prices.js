// One-shot: splits the legacy data/prices.csv into monthly partitions under
// data/prices/ (by scrape month) and deletes the original. Safe to re-run:
// does nothing if prices.csv is already gone.
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { appendRows, CSV_PATH, PRICES_DIR } = require("../lib/store");

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log("data/prices.csv no existe; nada que migrar.");
    return;
  }
  if (fs.existsSync(PRICES_DIR) && fs.readdirSync(PRICES_DIR).length > 0) {
    console.error("data/prices/ ya tiene particiones; abortando para no duplicar filas.");
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_PATH, "utf8").replace(/\r\n/g, "\n");
  const rows = parse(content, { columns: true, skip_empty_lines: true, record_delimiter: "\n" });
  console.log(`Leídas ${rows.length} filas de data/prices.csv`);

  appendRows(rows);
  fs.unlinkSync(CSV_PATH);

  const partitions = fs.readdirSync(PRICES_DIR).sort();
  console.log(`Escritas ${partitions.length} particiones: ${partitions.join(", ")}`);
  console.log("data/prices.csv eliminado.");
}

main();
