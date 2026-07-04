const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");
const { buildBookingLink } = require("./links");
const { getRate } = require("./exchangeRate");

const DATA_DIR = path.join(__dirname, "..", "data");

function loadSummary(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
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

function ddmmyyyyToISO(str) {
  if (!str) return null;
  const [d, m, y] = str.split("/");
  return `${y}-${m}-${d}`;
}

function formatARS(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(value);
}

// One card per route showing only the single best price found across every
// scraped date (not the full day-by-day table, that lives in the attached
// CSV), a link to book it, and its ARS equivalent when it's quoted in BRL.
function buildRouteCards(rows, brlToArsRate) {
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
    const fechaLabel = isRoundtrip
      ? `salida ${best.fecha_salida}, vuelta ${best.fecha_vuelta}`
      : `salida ${best.fecha_salida}`;

    const arsLine =
      brlToArsRate && best.mejor_precio.startsWith("R$")
        ? `<div style="font-size:13px;color:#777;">≈ ${formatARS(best.__value * brlToArsRate)}</div>`
        : "";

    const link = buildBookingLink(best.mejor_sitio, {
      origin: best.origen,
      destination: best.destino,
      departISO: ddmmyyyyToISO(best.fecha_salida),
      returnISO: isRoundtrip ? ddmmyyyyToISO(best.fecha_vuelta) : null,
    });

    html += `
      <div style="border:1px solid #e0e0e0;border-radius:8px;padding:14px 18px;margin-bottom:12px;font-family:Arial,sans-serif;">
        <div style="font-size:15px;color:#1a1a1a;font-weight:bold;margin-bottom:4px;">📍 ${ruta}</div>
        <div style="font-size:20px;color:#0a7a34;font-weight:bold;">${best.mejor_precio}</div>
        ${arsLine}
        <div style="font-size:13px;color:#555;margin-top:2px;">con ${best.mejor_sitio} &middot; ${fechaLabel}</div>
        ${link ? `<div style="margin-top:8px;"><a href="${link}" style="font-size:13px;color:#1a73e8;text-decoration:none;font-weight:bold;">🔗 Ver y comprar</a></div>` : ""}
      </div>`;
  }
  return html || `<p style="font-family:Arial,sans-serif;">Todavía no encontramos precios para estas rutas.</p>`;
}

function wrapEmail(title, bodyHtml) {
  return `
    <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#1a1a1a;">
      <h2 style="margin-bottom:12px;">✈️ ${title}</h2>
      ${bodyHtml}
      <p style="font-size:12px;color:#888;margin-top:20px;">
        Adjunto: detalle día por día de todas las fechas y aerolíneas (se abre con Excel o Google Sheets).
      </p>
      <p style="font-size:11px;color:#aaa;margin-top:16px;">Generado automáticamente por vuelos-tracker.</p>
    </div>`;
}

async function sendSummaryEmails() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el envío de emails.");
    return;
  }

  const isTestRun = process.env.IS_TEST_RUN === "true";
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const pabloRows = loadSummary("resumen-pablo.csv");
  const davidRows = loadSummary("resumen-david.csv");
  const fecha = new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  const brlToArsRate = await getRate("BRL", "ARS");
  const subjectPrefix = isTestRun ? "[PRUEBA] " : "";

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "pabloacevedo.contacto@gmail.com",
    subject: `${subjectPrefix}Precios de vuelos - actualizado ${fecha}`,
    html: wrapEmail(
      "Precios de vuelos a Brasil",
      `<h3 style="margin:20px 0 8px;">Octubre (solo ida, Gol)</h3>${buildRouteCards(pabloRows, brlToArsRate)}` +
        `<h3 style="margin:20px 0 8px;">Diciembre a febrero (ida y vuelta)</h3>${buildRouteCards(davidRows, brlToArsRate)}`
    ),
    attachments: [
      { filename: "detalle-octubre.csv", path: path.join(DATA_DIR, "resumen-pablo.csv") },
      { filename: "detalle-diciembre-febrero.csv", path: path.join(DATA_DIR, "resumen-david.csv") },
    ],
  });

  if (isTestRun) {
    console.log("Modo prueba: se salta el email a David (musicadelcielo3@gmail.com)");
  } else {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "musicadelcielo3@gmail.com",
      subject: `Precios de vuelos - actualizado ${fecha}`,
      html: wrapEmail("Precios de vuelos a Brasil — Diciembre a Febrero", buildRouteCards(davidRows, brlToArsRate)),
      attachments: [{ filename: "detalle-diciembre-febrero.csv", path: path.join(DATA_DIR, "resumen-david.csv") }],
    });
  }

  console.log(
    isTestRun
      ? "Email enviado (solo a Pablo, modo prueba)"
      : "Emails enviados a pabloacevedo.contacto@gmail.com y musicadelcielo3@gmail.com"
  );
}

module.exports = { sendSummaryEmails };
