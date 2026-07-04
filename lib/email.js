const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");

function loadSummary(fileName) {
  const filePath = path.join(__dirname, "..", "data", fileName);
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    record_delimiter: "\n",
  });
}

// "R$ 1.250,23" / "$ 1.250,23" -> 1250.23 (pt-BR/es-AR both use . thousands, , decimal)
function parseFormattedPrice(formatted) {
  if (!formatted) return null;
  const digits = formatted.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const value = parseFloat(digits);
  return Number.isNaN(value) ? null : value;
}

function buildRouteSections(rows) {
  const isRoundtrip = rows.length > 0 && "fecha_vuelta" in rows[0];

  const byRoute = new Map();
  for (const row of rows) {
    if (!row.mejor_precio) continue;
    if (!byRoute.has(row.ruta)) byRoute.set(row.ruta, []);
    byRoute.get(row.ruta).push(row);
  }

  let html = "";
  for (const [ruta, routeRows] of byRoute) {
    const withValue = routeRows
      .map((r) => ({ ...r, __value: parseFormattedPrice(r.mejor_precio) }))
      .filter((r) => r.__value != null);
    if (!withValue.length) continue;
    withValue.sort((a, b) => a.__value - b.__value);
    const best = withValue[0];
    const fechaLabel = isRoundtrip ? `${best.fecha_salida} - ${best.fecha_vuelta}` : best.fecha_salida;

    const tableRows = withValue
      .sort((a, b) => a.fecha_salida.localeCompare(b.fecha_salida))
      .map(
        (r) => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;">${r.fecha_salida}</td>
          ${isRoundtrip ? `<td style="padding:6px 10px;border:1px solid #e0e0e0;">${r.fecha_vuelta}</td>` : ""}
          <td style="padding:6px 10px;border:1px solid #e0e0e0;">${r.mejor_precio}</td>
          <td style="padding:6px 10px;border:1px solid #e0e0e0;">${r.mejor_sitio}</td>
        </tr>`
      )
      .join("");

    html += `
      <h3 style="font-family:Arial,sans-serif;color:#1a1a1a;margin:28px 0 4px;">${ruta}</h3>
      <p style="font-family:Arial,sans-serif;font-size:15px;margin:0 0 10px;">
        <strong style="color:#0a7a34;">Mejor precio encontrado: ${best.mejor_precio}</strong>
        (${best.mejor_sitio}) &mdash; ${fechaLabel}
      </p>
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin-bottom:8px;">
        <tr style="background:#f2f2f2;">
          <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left;">Salida</th>
          ${isRoundtrip ? '<th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left;">Vuelta</th>' : ""}
          <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left;">Mejor precio</th>
          <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left;">Sitio</th>
        </tr>
        ${tableRows}
      </table>`;
  }
  return html || `<p style="font-family:Arial,sans-serif;">Todavía no hay precios cargados.</p>`;
}

function wrapEmail(title, sections) {
  return `
    <div style="max-width:640px;margin:0 auto;">
      <h2 style="font-family:Arial,sans-serif;color:#1a1a1a;">${title}</h2>
      ${sections}
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:24px;">
        Generado automáticamente por vuelos-tracker.
      </p>
    </div>`;
}

async function sendSummaryEmails() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el envío de emails.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const pabloRows = loadSummary("resumen-pablo.csv");
  const davidRows = loadSummary("resumen-david.csv");
  const fecha = new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "pabloacevedo.contacto@gmail.com",
    subject: `Precios de vuelos - actualizado ${fecha}`,
    html: wrapEmail(
      "✈️ Vuelos a Brasil",
      wrapEmail("Octubre (solo ida, Gol)", buildRouteSections(pabloRows)) +
        wrapEmail("Diciembre - Febrero (ida y vuelta)", buildRouteSections(davidRows))
    ),
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "musicadelcielo3@gmail.com",
    subject: `Precios de vuelos - actualizado ${fecha}`,
    html: wrapEmail("✈️ Vuelos a Brasil — Diciembre a Febrero", buildRouteSections(davidRows)),
  });

  console.log("Emails enviados a pabloacevedo.contacto@gmail.com y musicadelcielo3@gmail.com");
}

module.exports = { sendSummaryEmails };
