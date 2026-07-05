const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");
const { buildBookingLink } = require("./links");
const { getRate } = require("./exchangeRate");
const { getHistoryStats, keyOf } = require("./history");
const { isoToDDMMYYYY } = require("./dates");
const routes = require("../config/routes.json");

const DATA_DIR = path.join(__dirname, "..", "data");

// Design tokens (see design spec: Plus Jakarta Sans, #0052cc primary, 8px
// radius, 8px-multiple spacing). Centralized here instead of repeating hex
// values so the whole email stays in sync with one source of truth.
const FONT_STACK = "'Plus Jakarta Sans', Arial, sans-serif";
const COLOR_PRIMARY = "#0052cc";
const COLOR_BG = "#f8f9fb";
const COLOR_SURFACE = "#ffffff";
const COLOR_TEXT = "#1a1c1e";
const COLOR_TEXT_SECONDARY = "#44474e";
const COLOR_BORDER = "#e6e7eb";
const COLOR_SUCCESS = "#0a7a34";
const COLOR_DANGER = "#b03030";
const RADIUS = "8px";
// "Headline" scale (24px bold) for section headers ("Octubre...", "Diciembre...").
const SECTION_HEADING_STYLE = `margin:24px 0 16px;font-size:24px;font-weight:bold;color:${COLOR_TEXT};`;

// Summary CSVs (the ones attached to the email) don't carry route_id -- it's
// an internal id, not something the recipient needs to see in their
// spreadsheet. Reconstruct it here instead, from origin+destination, which is
// unique per person (verified against config/routes.json).
function buildRouteIdLookup(person) {
  const map = {};
  for (const route of routes) {
    if (route.person !== person) continue;
    map[`${route.origin}|${route.destination}`] = route.id;
  }
  return map;
}

function loadSummary(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  return parse(content, {
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

const CURRENCY_LOCALES = { BRL: "pt-BR", ARS: "es-AR", USD: "en-US" };
function formatMoney(value, currency) {
  const locale = CURRENCY_LOCALES[currency] || "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency || "USD" }).format(value);
}

// Looks up the historical stats (min/avg/previous run) for whichever site
// ended up as the best price for this trip option, so the badge and delta
// line always describe the price actually shown on the card.
function historyForBest(best, isRoundtrip, routeIdLookup, historyStats) {
  const routeId = routeIdLookup[`${best.origen}|${best.destino}`];
  if (!routeId) return null;
  const key = keyOf({
    route_id: routeId,
    depart_date: ddmmyyyyToISO(best.fecha_salida),
    return_date: isRoundtrip ? ddmmyyyyToISO(best.fecha_vuelta) : "",
    site: best.mejor_sitio,
  });
  return historyStats.get(key) || null;
}

function buildBadgeHtml(stats) {
  if (!stats || stats.history.length <= 1) return "";
  if (stats.isNewHistoricalMin) {
    return `<div style="font-size:14px;color:#b8860b;font-weight:600;margin-top:4px;">🏆 Nuevo mínimo histórico</div>`;
  }
  if (stats.isTiedWithMin) {
    return `<div style="font-size:14px;color:#b8860b;margin-top:4px;">Igual al mínimo histórico</div>`;
  }
  return "";
}

function buildDeltaHtml(stats) {
  if (!stats || stats.previousPrice == null) return "";
  if (stats.deltaFromPrevious === 0) {
    return `<div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:4px;">Sin cambios desde la última actualización</div>`;
  }
  const down = stats.deltaFromPrevious < 0;
  const arrow = down ? "⬇" : "⬆";
  const verb = down ? "Bajó" : "Subió";
  const amount = formatMoney(Math.abs(stats.deltaFromPrevious), stats.currency);
  const color = down ? COLOR_SUCCESS : COLOR_DANGER;
  return `<div style="font-size:14px;color:${color};margin-top:4px;">${arrow} ${verb} ${amount} desde la última actualización</div>`;
}

// BRL prices need the day's exchange rate to compare against ARS ones; if the
// rate API failed (brlToArsRate is null) that entry is left out of the
// dashboard's best-price/average rather than mixing currencies.
function toARS(value, formattedPrice, brlToArsRate) {
  if (formattedPrice.startsWith("R$")) return brlToArsRate ? value * brlToArsRate : null;
  return value;
}

// Real logos from Google Flights' public airline-logo CDN (unauthenticated,
// keyed by IATA code, verified reachable) -- avoids both a guessed/broken
// image URL and the earlier text-badge placeholder.
const AIRLINE_INFO = {
  gol: { name: "Gol", iata: "G3" },
  aerolineas: { name: "Aerolíneas Argentinas", iata: "AR" },
};
// Brand accent colors, keyed by IATA code so the same lookup works for both
// site-based cards (Gol/Aerolineas) and the Google Flights section, where the
// operating airline varies per card instead of being fixed by "site".
const AIRLINE_ACCENT_BY_IATA = {
  G3: "#ff5a00", // Gol
  LA: "#e60050", // LATAM
  AR: "#00205b", // Aerolineas Argentinas
};
function airlineLogoUrl(iata) {
  return `https://www.gstatic.com/flights/airline_logos/70px/${iata}.png`;
}
function airlineInfoFor(site) {
  const info = AIRLINE_INFO[site] || { name: site, iata: null };
  return { ...info, color: AIRLINE_ACCENT_BY_IATA[info.iata] || COLOR_TEXT_SECONDARY };
}
function accentColorForIata(iata) {
  return AIRLINE_ACCENT_BY_IATA[iata] || COLOR_PRIMARY;
}
// The logo itself is already a wordmark (it renders "GOL"/"AR" as part of the
// image), so pairing it with a redundant text label next to it looks
// cluttered -- just the logo, sized like a real OTA badge, alt text carries
// the name for accessibility/if the image fails to load.
function buildAirlineLogoHtml(site) {
  const info = airlineInfoFor(site);
  if (!info.iata) return `<span style="font-size:14px;font-weight:600;color:${COLOR_TEXT};">${info.name}</span>`;
  return `<img src="${airlineLogoUrl(info.iata)}" height="28" alt="${info.name}" title="${info.name}" style="display:block;object-fit:contain;border-radius:4px;" />`;
}

function buildTripTypeTag(isRoundtrip) {
  return `<span style="display:inline-block;background:#eef2ff;color:${COLOR_PRIMARY};font-size:14px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;">${isRoundtrip ? "Ida y vuelta" : "Solo ida"}</span>`;
}

const SPANISH_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function formatDateLabel(ddmmyyyy) {
  if (!ddmmyyyy) return "";
  const [d, m, y] = ddmmyyyy.split("/");
  return `${parseInt(d, 10)} ${SPANISH_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

function formatTimeLabel(isoDateTime) {
  if (!isoDateTime) return "";
  const time = isoDateTime.split("T")[1];
  return time ? time.slice(0, 5) : "";
}

// Aerolineas is the only site whose scraper captures segment-level schedule
// data (see scrapers/aerolineas.js); everything else only ever has price/date,
// so this returns null for any other site rather than showing partial info.
function parseSchedule(stats, site) {
  if (site !== "aerolineas" || !stats || !stats.latestNotes) return null;
  try {
    const parsed = JSON.parse(stats.latestNotes);
    return parsed && (parsed.out || parsed.in) ? parsed : null;
  } catch {
    return null;
  }
}

function formatDuration(totalDurationMin) {
  if (totalDurationMin == null) return "";
  return `${Math.floor(totalDurationMin / 60)}h${String(totalDurationMin % 60).padStart(2, "0")}`;
}

function stopsLabelFor(legSchedule) {
  if (!legSchedule.stops) return "Directo";
  const stopAirports = legSchedule.segments.slice(0, -1).map((s) => s.destination).join(", ");
  return `${legSchedule.stops} escala${legSchedule.stops > 1 ? "s" : ""} (${stopAirports})`;
}

// Table-based (not flex) on purpose: some email clients render flex layouts
// unreliably, causing columns to collapse or overlap; <table> is the
// well-supported baseline for multi-column layout in HTML email.
function airportCellHtml(label, primary, secondary, align) {
  return `<td width="30%" style="vertical-align:top;text-align:${align};">
    <div style="font-size:14px;font-weight:600;color:${COLOR_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
    <div style="font-size:16px;font-weight:bold;color:${COLOR_TEXT};margin-top:4px;">${primary}</div>
    <div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:2px;">${secondary}</div>
  </td>`;
}

function connectorCellHtml(centerLabel) {
  return `<td width="40%" style="vertical-align:middle;text-align:center;padding:0 8px;">
    ${centerLabel ? `<div style="font-size:12px;color:${COLOR_TEXT_SECONDARY};margin-bottom:4px;">${centerLabel}</div>` : ""}
    <div style="border-top:1px dashed #ccc;line-height:0;">
      <span style="background:${COLOR_SURFACE};padding:0 4px;font-size:12px;position:relative;top:-8px;">✈</span>
    </div>
  </td>`;
}

// origin/destination: { code, name } for each side of the leg. Always shows
// both airports -- even without schedule data (Gol) it falls back to the
// date instead of dropping the destination side entirely.
function buildLegRowHtml(legLabel, dateLabel, legSchedule, origin, destination) {
  const legLabelHtml = legLabel
    ? `<div style="font-size:14px;font-weight:600;color:${COLOR_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${legLabel}</div>`
    : "";

  if (!legSchedule || !legSchedule.segments?.length) {
    return `
      <div style="margin:16px 0;">
        ${legLabelHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${airportCellHtml("Salida", dateLabel, origin.name, "left")}
          ${connectorCellHtml("")}
          ${airportCellHtml("Destino", destination.name, destination.code, "right")}
        </tr></table>
      </div>`;
  }

  const first = legSchedule.segments[0];
  const last = legSchedule.segments[legSchedule.segments.length - 1];
  const centerLabel = `${formatDuration(legSchedule.totalDurationMin)} &middot; ${stopsLabelFor(legSchedule)}`;
  return `
    <div style="margin:16px 0;">
      ${legLabelHtml}
      <div style="font-size:12px;color:${COLOR_TEXT_SECONDARY};margin-bottom:6px;">${dateLabel}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${airportCellHtml("Salida", formatTimeLabel(first.departure), first.origin, "left")}
        ${connectorCellHtml(centerLabel)}
        ${airportCellHtml("Llegada", formatTimeLabel(last.arrival), last.destination, "right")}
      </tr></table>
    </div>`;
}

// origin/destination: { code, name } for the outbound direction; swapped for
// the return leg since the plane is flying the other way.
function buildTripLayoutHtml(best, isRoundtrip, schedule, origin, destination) {
  if (!isRoundtrip) {
    return buildLegRowHtml(null, formatDateLabel(best.fecha_salida), schedule?.out, origin, destination);
  }
  const departBlock = buildLegRowHtml("Ida", formatDateLabel(best.fecha_salida), schedule?.out, origin, destination);
  const returnBlock = buildLegRowHtml("Vuelta", formatDateLabel(best.fecha_vuelta), schedule?.in, destination, origin);
  return `${departBlock}<div style="border-top:1px dashed #eee;margin:2px 0;"></div>${returnBlock}`;
}

// The original scraped currency is always the primary figure (it's the
// price you'd actually be charged); the converted figure underneath is just
// a reference, regardless of who's reading the email.
function buildPriceBlockHtml(best, brlToArsRate) {
  if (!brlToArsRate) {
    return `<div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${best.mejor_precio}</div>`;
  }
  const isBRL = best.mejor_precio.startsWith("R$");
  const convertedValue = isBRL ? best.__value * brlToArsRate : best.__value / brlToArsRate;
  const convertedLabel = formatMoney(convertedValue, isBRL ? "ARS" : "BRL");
  return `
    <div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${best.mejor_precio}</div>
    <div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};">≈ ${convertedLabel}</div>`;
}

// EZE and AEP are both "Buenos Aires" for the traveler's purposes -- scraped
// as separate routes internally (different airport codes), but shown as one
// option so the recipient isn't comparing two near-duplicate cards for the
// same trip. Anything else (Santiago, San Luis) keeps its own card as-is.
const BUE_AIRPORT_CODES = new Set(["EZE", "AEP"]);
const BUE_AIRPORT_NAMES = { EZE: "Ezeiza", AEP: "Aeroparque" };

function groupKeyFor(row) {
  return BUE_AIRPORT_CODES.has(row.origen) ? `BUE|${row.destino}` : `${row.origen}|${row.destino}`;
}

// Falls back to the full label if it isn't in the expected "Origen - Destino" shape.
function destinationLabelFor(ruta) {
  const parts = ruta.split(" - ");
  return parts.length > 1 ? parts[parts.length - 1].trim() : ruta;
}

function originLabelFor(ruta) {
  const parts = ruta.split(" - ");
  return parts.length > 1 ? parts[0].trim() : ruta;
}

// One card per route showing only the single best price found across every
// scraped date (not the full day-by-day table, that lives in the attached
// CSV), a link to book it, and its ARS equivalent when it's quoted in BRL.
// Also returns a `summary` used to build the dashboard block at the top of
// the email (best price, routes analyzed, sites consulted, etc).
function buildRouteCards(rows, brlToArsRate, historyStats, routeIdLookup) {
  const isRoundtrip = rows.length > 0 && "fecha_vuelta" in rows[0];

  const summary = { routesCount: 0, sites: new Set(), newMinCount: 0, droppedCount: 0, bestARS: null, sumARS: 0, countARS: 0, routes: [] };
  for (const key of rows.length ? Object.keys(rows[0]) : []) {
    if (key.startsWith("precio_")) summary.sites.add(key.slice("precio_".length));
  }

  const byRoute = new Map();
  for (const row of rows) {
    if (!row.mejor_precio) continue;
    const key = groupKeyFor(row);
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(row);
  }

  let html = "";
  for (const [groupKey, routeRows] of byRoute) {
    const withValue = routeRows
      .map((r) => ({ ...r, __value: parseFormattedPrice(r.mejor_precio) }))
      .filter((r) => r.__value != null);
    if (!withValue.length) continue;
    withValue.sort((a, b) => a.__value - b.__value);
    const best = withValue[0];

    const isBueGroup = groupKey.startsWith("BUE|");
    const ruta = isBueGroup ? `Buenos Aires → ${destinationLabelFor(routeRows[0].ruta)}` : routeRows[0].ruta;
    const originInfo = {
      code: best.origen,
      name: isBueGroup ? BUE_AIRPORT_NAMES[best.origen] || best.origen : originLabelFor(routeRows[0].ruta),
    };
    const destinationInfo = { code: best.destino, name: destinationLabelFor(routeRows[0].ruta) };

    const link = buildBookingLink(best.mejor_sitio, {
      origin: best.origen,
      destination: best.destino,
      departISO: ddmmyyyyToISO(best.fecha_salida),
      returnISO: isRoundtrip ? ddmmyyyyToISO(best.fecha_vuelta) : null,
    });

    const stats = historyStats && routeIdLookup ? historyForBest(best, isRoundtrip, routeIdLookup, historyStats) : null;
    const badgeHtml = buildBadgeHtml(stats);
    const deltaHtml = badgeHtml ? "" : buildDeltaHtml(stats);
    const schedule = parseSchedule(stats, best.mejor_sitio);

    summary.routesCount++;
    if (stats && stats.isNewHistoricalMin) summary.newMinCount++;
    if (stats && stats.previousPrice != null && stats.deltaFromPrevious < 0) summary.droppedCount++;
    const ars = toARS(best.__value, best.mejor_precio, brlToArsRate);
    if (ars != null) {
      summary.sumARS += ars;
      summary.countARS++;
      if (summary.bestARS == null || ars < summary.bestARS.value) {
        summary.bestARS = { value: ars, label: best.mejor_precio, ruta };
      }
    }

    const accentColor = airlineInfoFor(best.mejor_sitio).color;

    summary.routes.push({
      shortLabel: `${isBueGroup ? "BUE" : best.origen} → ${best.destino}`,
      price: best.mejor_precio,
      site: best.mejor_sitio,
      link,
      vsAvgPercent: stats && stats.avg ? Math.round(((best.__value - stats.avg) / stats.avg) * 100) : null,
    });

    html += `
      <div style="border:1px solid ${COLOR_BORDER};border-top:4px solid ${accentColor};border-radius:${RADIUS};padding:16px;margin-bottom:16px;font-family:${FONT_STACK};background:${COLOR_SURFACE};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;">
            <div style="font-size:16px;color:${COLOR_TEXT};font-weight:bold;">📍 ${ruta}</div>
            <div style="margin-top:8px;">${buildTripTypeTag(isRoundtrip)}</div>
          </td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;">
            <div style="font-size:14px;font-weight:600;color:${COLOR_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Aerolínea</div>
            ${buildAirlineLogoHtml(best.mejor_sitio)}
          </td>
        </tr></table>
        ${buildTripLayoutHtml(best, isRoundtrip, schedule, originInfo, destinationInfo)}
        ${badgeHtml}
        ${deltaHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;padding-top:16px;border-top:1px solid ${COLOR_BORDER};"><tr>
          <td style="vertical-align:middle;">${buildPriceBlockHtml(best, brlToArsRate)}</td>
          <td style="vertical-align:middle;text-align:right;">${link ? `<a href="${link}" style="display:inline-block;background:${COLOR_PRIMARY};color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:${RADIUS};white-space:nowrap;">Ver y comprar</a>` : ""}</td>
        </tr></table>
      </div>`;
  }
  const finalHtml = html || `<p style="font-family:${FONT_STACK};color:${COLOR_TEXT_SECONDARY};">Todavía no encontramos precios para estas rutas.</p>`;
  return { html: finalHtml, summary };
}

function mergeSummaries(a, b) {
  const merged = {
    routesCount: a.routesCount + b.routesCount,
    sites: new Set([...a.sites, ...b.sites]),
    newMinCount: a.newMinCount + b.newMinCount,
    droppedCount: a.droppedCount + b.droppedCount,
    sumARS: a.sumARS + b.sumARS,
    countARS: a.countARS + b.countARS,
    bestARS: a.bestARS,
    routes: [...a.routes, ...b.routes],
  };
  if (b.bestARS && (!merged.bestARS || b.bestARS.value < merged.bestARS.value)) merged.bestARS = b.bestARS;
  return merged;
}

function buildDashboardRouteBoxHtml(route) {
  const trendHtml =
    route.vsAvgPercent == null
      ? `<div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};">— vs promedio</div>`
      : `<div style="font-size:14px;color:${route.vsAvgPercent <= 0 ? COLOR_SUCCESS : COLOR_DANGER};">${route.vsAvgPercent <= 0 ? "↘" : "↗"} ${route.vsAvgPercent > 0 ? "+" : ""}${route.vsAvgPercent}% vs promedio</div>`;
  const info = airlineInfoFor(route.site);
  const logoHtml = info.iata
    ? `<img src="${airlineLogoUrl(info.iata)}" height="18" alt="${info.name}" style="display:block;object-fit:contain;" />`
    : "";

  const inner = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td colspan="2" style="font-size:14px;color:${COLOR_TEXT_SECONDARY};padding-bottom:4px;">${route.shortLabel}</td>
      </tr>
      <tr>
        <td style="font-size:20px;color:${COLOR_TEXT};font-weight:bold;">${route.price}</td>
        <td style="text-align:right;vertical-align:middle;">${logoHtml}</td>
      </tr>
      <tr>
        <td colspan="2">${trendHtml}</td>
      </tr>
    </table>`;

  const boxStyle = `display:block;box-sizing:border-box;width:100%;background:${COLOR_SURFACE};border:1px solid ${COLOR_BORDER};border-radius:${RADIUS};padding:12px;text-decoration:none;color:inherit;`;
  return route.link
    ? `<a href="${route.link}" style="${boxStyle}">${inner}</a>`
    : `<div style="${boxStyle}">${inner}</div>`;
}

// Two boxes per row via <table> (not flex-wrap, which some clients render
// unpredictably with 4-5 items in a 600px-wide email).
function buildDashboardBoxesHtml(routeList) {
  if (!routeList.length) return "";
  const rowsHtml = [];
  for (let i = 0; i < routeList.length; i += 2) {
    const pair = routeList.slice(i, i + 2);
    rowsHtml.push(`
      <tr>
        <td width="50%" style="padding:4px;vertical-align:top;">${buildDashboardRouteBoxHtml(pair[0])}</td>
        <td width="50%" style="padding:4px;vertical-align:top;">${pair[1] ? buildDashboardRouteBoxHtml(pair[1]) : ""}</td>
      </tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">${rowsHtml.join("")}</table>`;
}

// Small monochrome line icons (not emoji) for the aggregate stats row, kept
// deliberately subtle -- this block is meta-info about the run, not the
// headline content.
const ICON_ROUTE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${COLOR_TEXT_SECONDARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4M6 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>`;
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${COLOR_TEXT_SECONDARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>`;

function buildStatItemHtml(iconSvg, text) {
  return `<span style="display:inline-block;margin-right:24px;white-space:nowrap;"><span style="display:inline-block;vertical-align:middle;">${iconSvg}</span> <span style="font-size:14px;color:${COLOR_TEXT_SECONDARY};vertical-align:middle;">${text}</span></span>`;
}

// Summary block at the top of the email: one clickable box per route (price +
// vs-historical-average trend + airline logo), then the aggregate stats below
// -- deliberately subtle (small icons, secondary text color) so it reads as
// meta-info, not competing with the actual price cards.
function buildDashboardHtml(summary) {
  const boxesHtml = buildDashboardBoxesHtml(summary.routes);

  const mainStatsHtml = `<div style="margin-bottom:8px;">${buildStatItemHtml(
    ICON_ROUTE,
    `${summary.routesCount} rutas analizadas`
  )}${buildStatItemHtml(ICON_GLOBE, `${summary.sites.size} sitios consultados`)}</div>`;

  const extraLines = [];
  if (summary.newMinCount > 0) {
    extraLines.push(`${summary.newMinCount} nuevos mínimos históricos`);
  }
  if (summary.droppedCount > 0) {
    extraLines.push(`${summary.droppedCount} precios bajaron desde la última actualización`);
  }
  if (summary.countARS > 0) {
    extraLines.push(`Precio promedio (convertido a ARS): ${formatARS(summary.sumARS / summary.countARS)}`);
  }
  const extraHtml = extraLines
    .map((line) => `<div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-bottom:4px;">${line}</div>`)
    .join("");

  return `
    <div style="background:${COLOR_BG};border-radius:${RADIUS};padding:16px;margin-bottom:24px;font-family:${FONT_STACK};">
      ${boxesHtml}
      ${mainStatsHtml}
      ${extraHtml}
    </div>`;
}

function formatUpdatedAt(iso) {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

// Separate, clearly-labeled section built directly from history (bypassing
// the resumen-*.csv pivot on purpose -- see lib/summary.js) so this once-a-day
// Google Flights snapshot never gets confused with the live Gol/Aerolineas
// cards above, which update on every cron run.
function buildGoogleFlightsSectionHtml(historyStats, brlToArsRate) {
  const googleFlightsRoutes = routes.filter((r) => r.sites.includes("googleflights"));
  if (!googleFlightsRoutes.length) return "";

  let latestScrapedAt = null;
  let html = "";

  for (const route of googleFlightsRoutes) {
    let stats = null;
    let departISO = null;
    let returnISO = null;
    for (const [key, s] of historyStats) {
      const [routeId, depart, ret, site] = key.split("|");
      if (routeId === route.id && site === "googleflights") {
        stats = s;
        departISO = depart;
        returnISO = ret;
        break;
      }
    }
    if (!stats || stats.latestPrice == null) continue;

    const latest = stats.history[stats.history.length - 1];
    if (!latestScrapedAt || latest.scraped_at > latestScrapedAt) latestScrapedAt = latest.scraped_at;

    let schedule = null;
    try {
      schedule = JSON.parse(stats.latestNotes);
    } catch {
      schedule = null;
    }

    const firstSegment = schedule?.out?.segments?.[0];
    const iata = firstSegment?.flightNumber?.split(" ")[0];
    const airlineName = firstSegment?.airline || "Google Flights";
    const logoHtml = iata
      ? `<img src="${airlineLogoUrl(iata)}" height="28" alt="${airlineName}" title="${airlineName}" style="display:block;object-fit:contain;border-radius:4px;" />`
      : "";

    const isBueGroup = BUE_AIRPORT_CODES.has(route.origin);
    const ruta = isBueGroup ? `Buenos Aires → ${destinationLabelFor(route.label)}` : route.label;
    const originInfo = {
      code: route.origin,
      name: isBueGroup ? BUE_AIRPORT_NAMES[route.origin] || route.origin : originLabelFor(route.label),
    };
    const destinationInfo = { code: route.destination, name: destinationLabelFor(route.label) };

    const priceFormatted = formatMoney(stats.latestPrice, stats.currency);
    const priceBlockHtml = brlToArsRate
      ? `<div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${priceFormatted}</div>
         <div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};">≈ ${formatMoney(stats.latestPrice * brlToArsRate, "ARS")}</div>`
      : `<div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${priceFormatted}</div>`;

    const fakeBest = { fecha_salida: isoToDDMMYYYY(departISO), fecha_vuelta: isoToDDMMYYYY(returnISO) };
    const link = schedule?.link || null;
    const accentColor = accentColorForIata(iata);

    html += `
      <div style="border:1px solid ${COLOR_BORDER};border-top:4px solid ${accentColor};border-radius:${RADIUS};padding:16px;margin-bottom:16px;font-family:${FONT_STACK};background:${COLOR_SURFACE};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;">
            <div style="font-size:16px;color:${COLOR_TEXT};font-weight:bold;">📍 ${ruta}</div>
            <div style="margin-top:8px;">${buildTripTypeTag(true)}</div>
          </td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;">
            <div style="font-size:14px;font-weight:600;color:${COLOR_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Aerolínea</div>
            ${logoHtml}
          </td>
        </tr></table>
        ${buildTripLayoutHtml(fakeBest, true, schedule, originInfo, destinationInfo)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;padding-top:16px;border-top:1px solid ${COLOR_BORDER};"><tr>
          <td style="vertical-align:middle;">${priceBlockHtml}</td>
          <td style="vertical-align:middle;text-align:right;">${link ? `<a href="${link}" style="display:inline-block;background:${COLOR_PRIMARY};color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:${RADIUS};white-space:nowrap;">Ver en Google Flights</a>` : ""}</td>
        </tr></table>
      </div>`;
  }

  if (!html) return "";

  const updatedLabel = latestScrapedAt ? `actualizado hoy a las ${formatUpdatedAt(latestScrapedAt)}` : "";
  return `
    <h3 style="${SECTION_HEADING_STYLE}">📡 Todas las aerolíneas (Google Flights)</h3>
    <p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin:0 0 16px;">Foto de una vez al día${updatedLabel ? ", " + updatedLabel : ""} — incluye aerolíneas que no monitoreamos en vivo (LATAM y otras).</p>
    ${html}`;
}

// Priority: a new historical low is always the headline, even if other prices
// rose elsewhere; otherwise, any price drop is worth a look; otherwise it's
// just a routine update with nothing actionable.
function buildSubject(summary, prefix) {
  if (summary.newMinCount > 0) return `${prefix}🔥 Nuevo mejor precio para uno de tus vuelos`;
  if (summary.droppedCount > 0) return `${prefix}✈️ Encontramos nuevos precios para tus vuelos`;
  return `${prefix}✈️ Actualización de tus vuelos a Brasil`;
}

// Forces light mode: without an explicit color-scheme, Gmail's mobile app
// dark-mode "smart" recoloring inverts backgrounds/borders and wrecks the
// deliberately-picked card colors (accent bars, price, CTA).
// Note on the font: email clients have inconsistent support for @import'd web
// fonts (Gmail webmail generally honors it, many mobile apps and Outlook
// don't) -- Arial is the fallback so the email still looks fine either way.
function wrapEmail(title, dashboardHtml, bodyHtml) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    </style>
  </head>
  <body style="background:${COLOR_BG};margin:0;padding:16px 0;">
    <div style="max-width:600px;margin:0 auto;font-family:${FONT_STACK};color:${COLOR_TEXT};background:${COLOR_SURFACE};padding:24px;border-radius:${RADIUS};">
      <h2 style="margin:0 0 16px;font-size:32px;font-weight:800;color:${COLOR_TEXT};">✈️ ${title}</h2>
      ${dashboardHtml}
      ${bodyHtml}
      <p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:24px;">
        Adjunto: detalle día por día de todas las fechas y aerolíneas (se abre con Excel o Google Sheets).
      </p>
      <p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:16px;">Generado automáticamente por vuelos-tracker.</p>
    </div>
  </body>
</html>`;
}

async function sendSummaryEmails() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el envío de emails.");
    return;
  }
  const pabloEmail = process.env.PABLO_EMAIL;
  const davidEmail = process.env.DAVID_EMAIL;
  if (!pabloEmail || !davidEmail) {
    console.log("PABLO_EMAIL/DAVID_EMAIL no configurados: se salta el envío de emails.");
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
  const historyStats = getHistoryStats();
  const pabloRouteIds = buildRouteIdLookup("pablo");
  const davidRouteIds = buildRouteIdLookup("david");

  const pabloResult = buildRouteCards(pabloRows, brlToArsRate, historyStats, pabloRouteIds);
  const davidResult = buildRouteCards(davidRows, brlToArsRate, historyStats, davidRouteIds);
  const googleFlightsHtml = buildGoogleFlightsSectionHtml(historyStats, brlToArsRate);

  const pabloSummary = mergeSummaries(pabloResult.summary, davidResult.summary);

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: pabloEmail,
    subject: buildSubject(pabloSummary, subjectPrefix),
    html: wrapEmail(
      "Precios de vuelos a Brasil",
      buildDashboardHtml(pabloSummary),
      `<h3 style="${SECTION_HEADING_STYLE}">Octubre (solo ida, Gol)</h3>${pabloResult.html}` +
        `<h3 style="${SECTION_HEADING_STYLE}">Diciembre a febrero (ida y vuelta)</h3>${davidResult.html}` +
        googleFlightsHtml
    ),
    attachments: [
      { filename: "detalle-octubre.csv", path: path.join(DATA_DIR, "resumen-pablo.csv") },
      { filename: "detalle-diciembre-febrero.csv", path: path.join(DATA_DIR, "resumen-david.csv") },
    ],
  });

  if (isTestRun) {
    console.log("Modo prueba: se salta el email a David");
  } else {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: davidEmail,
      subject: buildSubject(davidResult.summary, ""),
      html: wrapEmail(
        "Precios de vuelos a Brasil — Diciembre a Febrero",
        buildDashboardHtml(davidResult.summary),
        davidResult.html + googleFlightsHtml
      ),
      attachments: [{ filename: "detalle-diciembre-febrero.csv", path: path.join(DATA_DIR, "resumen-david.csv") }],
    });
  }

  console.log(isTestRun ? "Email enviado (solo a Pablo, modo prueba)" : "Emails enviados a Pablo y David");
}

module.exports = { sendSummaryEmails };
