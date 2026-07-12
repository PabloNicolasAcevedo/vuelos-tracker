const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");
const mjml2html = require("mjml");
const { buildBookingLink } = require("./links");
const { getRate } = require("./exchangeRate");
const { getHistoryStats, keyOf } = require("./history");
const { isoToDDMMYYYY } = require("./dates");
const routes = require("../config/routes.json");

const DATA_DIR = path.join(__dirname, "..", "data");

// Design tokens -- see design/tokens.json + design/email-design-system.md
// (the "Chebora" email design system) for the source of truth/rationale.
// Centralized here instead of repeating hex values so the whole email
// stays in sync with one source of truth.
const FONT_STACK = "'Plus Jakarta Sans', Arial, sans-serif";
const WORDMARK_FONT = "'Space Grotesk', 'Plus Jakarta Sans', Arial, sans-serif";
const COLOR_PRIMARY = "#0052cc";
const COLOR_BG = "#f8f9fb";
const COLOR_SURFACE = "#ffffff";
const COLOR_TEXT = "#1a1c1e";
const COLOR_TEXT_SECONDARY = "#44474e";
const COLOR_BORDER = "#e6e7eb";
const COLOR_SUCCESS = "#0a7a34";
const COLOR_DANGER = "#b03030";
const COLOR_INFO_BG = "#eef2ff";
const COLOR_INFO_TEXT = COLOR_PRIMARY;
// Unifies what used to be three slightly different golds (badge, alert
// reason pills, trophy icon) for the same "this is a highlight" concept.
const COLOR_ACCENT_BG = "#fef3e2";
const COLOR_ACCENT_TEXT = "#b45309";
const RADIUS_CARD = "12px"; // cards -- a bit more generous than the button radius, reads as 2024+
const RADIUS_BUTTON = "8px"; // CTA buttons stay narrower than the card so they read as clickable
const RADIUS_PILL = "999px";
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

// Trophy pill uses ICON_TROPHY (defined below) instead of an emoji -- see
// design/email-design-system.md §5 (zero-emoji policy).
function buildBadgeHtml(stats) {
  if (!stats || stats.history.length <= 1) return "";
  if (stats.isNewHistoricalMin) {
    return `<span style="display:inline-block;background:${COLOR_ACCENT_BG};color:${COLOR_ACCENT_TEXT};font-size:13px;font-weight:600;padding:4px 10px;border-radius:${RADIUS_PILL};margin-top:4px;"><span style="display:inline-block;vertical-align:middle;">${ICON_TROPHY}</span> <span style="vertical-align:middle;margin-left:4px;">Nuevo mínimo histórico</span></span>`;
  }
  if (stats.isTiedWithMin) {
    return `<span style="display:inline-block;background:${COLOR_ACCENT_BG};color:${COLOR_ACCENT_TEXT};font-size:13px;font-weight:600;padding:4px 10px;border-radius:${RADIUS_PILL};margin-top:4px;">Igual al mínimo histórico</span>`;
  }
  return "";
}

function buildDeltaHtml(stats) {
  if (!stats || stats.previousPrice == null) return "";
  if (stats.deltaFromPrevious === 0) {
    return `<div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:4px;">Sin cambios desde la última actualización</div>`;
  }
  const down = stats.deltaFromPrevious < 0;
  const arrow = down ? "⬇" : "⬆"; // Unicode arrow, not emoji -- kept per design/email-design-system.md
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

const AIRLINE_INFO = {
  gol: { name: "Gol", iata: "G3" },
  aerolineas: { name: "Aerolíneas Argentinas", iata: "AR" },
};
// Brand accent colors, keyed by IATA code so the same lookup works for both
// site-based cards (Gol/Aerolineas) and the Google Flights section, where the
// operating airline varies per card instead of being fixed by "site". These
// are real airline brand colors (kept intentionally, see design doc §2).
const AIRLINE_ACCENT_BY_IATA = {
  G3: "#ff5a00", // Gol
  LA: "#e60050", // LATAM
  AR: "#00205b", // Aerolineas Argentinas
};
function airlineInfoFor(site) {
  const info = AIRLINE_INFO[site] || { name: site, iata: null };
  return { ...info, color: AIRLINE_ACCENT_BY_IATA[info.iata] || COLOR_TEXT_SECONDARY };
}
function accentColorForIata(iata) {
  return AIRLINE_ACCENT_BY_IATA[iata] || COLOR_PRIMARY;
}
// Compact colored badge (IATA code on a brand-colored background) instead of
// an external logo image or long airline name -- never breaks (no network
// request) and never overflows a narrow column the way "Aerolíneas
// Argentinas" as plain text does.
function buildAirlineBadgeHtml(name, iata, color) {
  if (!iata) return `<span style="font-size:12px;font-weight:700;color:${color};">${name}</span>`;
  return `<span style="display:inline-block;background:${color};color:#ffffff;font-size:12px;font-weight:800;letter-spacing:0.5px;padding:4px 8px;border-radius:6px;line-height:1;">${iata}</span>`;
}
// Compact inline version (badge + name on one line) used next to the trip
// type pill in the card header -- no separate "AEROLÍNEA" label needed,
// it's obvious from context (see design/email-design-system.md §7.1).
function buildAirlineInlineHtml(site) {
  const info = airlineInfoFor(site);
  return `${buildAirlineBadgeHtml(info.name, info.iata, info.color)} <span style="font-size:13px;color:${COLOR_TEXT_SECONDARY};">${info.name}</span>`;
}

function buildTripTypeTag(isRoundtrip) {
  return `<span style="display:inline-block;background:${COLOR_INFO_BG};color:${COLOR_INFO_TEXT};font-size:14px;font-weight:600;padding:3px 10px;border-radius:${RADIUS_PILL};white-space:nowrap;">${isRoundtrip ? "Ida y vuelta" : "Solo ida"}</span>`;
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

// --- MJML layout helpers ------------------------------------------------
// MJML compiles mj-section/mj-column into the table markup + media queries
// email clients need for mobile stacking. But Gmail's Android app was found
// to render some multi-column rows (3 columns, or a button in a narrow
// column) inconsistently -- cards using that shape showed misaligned/
// collapsed content in testing, while simpler rows (2 plain-text columns,
// like the dashboard boxes) rendered correctly. So layout below deliberately
// stays to *at most two columns of plain text*; anything with more moving
// parts (the leg/connector row, the CTA button) is single-column instead of
// pushing multi-column layout further. See card components below.
function mjColumn(width, inner, attrs = "") {
  return `<mj-column width="${width}%" padding="0" ${attrs}>${inner}</mj-column>`;
}
function mjSection(innerColumns, attrs = "") {
  return `<mj-section padding="0" ${attrs}>${innerColumns}</mj-section>`;
}
function section1(inner, attrs = "") {
  return mjSection(mjColumn(100, inner), attrs);
}
function section2(a, b, wa, wb, attrs = "") {
  return mjSection(mjColumn(wa, a) + mjColumn(wb, b), attrs);
}
// Vertical gap between stacked full-width cards (mj-wrapper has no margin
// attribute, so this is an empty section acting as a spacer instead).
const CARD_SPACER = `<mj-section padding="8px 0 0 0"></mj-section>`;

// Tabler-icons-style outline plane (hand-traced, MIT-license-compatible
// shape), inline SVG so it renders identically everywhere -- no emoji font
// fallback differences between clients, no external image request to break.
const ICON_PLANE = (color) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3z"/></svg>`;

// One leg (outbound or return), rendered as a single stacked text block --
// no columns at all (see note on mjSection helpers above). Always shows
// both airports, even without schedule data (Gol), and keeps the plane icon
// as the origin/destination connector without needing a 3-column layout.
function buildLegRowMjml(legLabel, dateLabel, legSchedule, origin, destination) {
  const legLabelHtml = legLabel
    ? `<div style="font-size:12px;font-weight:600;color:${COLOR_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${legLabel}</div>`
    : "";

  if (!legSchedule || !legSchedule.segments?.length) {
    return section1(
      `<mj-text padding="0">
        ${legLabelHtml}
        <div style="font-size:16px;font-weight:bold;color:${COLOR_TEXT};">${dateLabel}</div>
        <div style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:2px;">${origin.name} ${ICON_PLANE(COLOR_TEXT_SECONDARY)} ${destination.name} (${destination.code})</div>
      </mj-text>`,
      `padding-bottom="12px"`
    );
  }

  const first = legSchedule.segments[0];
  const last = legSchedule.segments[legSchedule.segments.length - 1];
  const routeLine = `${formatTimeLabel(first.departure)} ${first.origin} ${ICON_PLANE(COLOR_TEXT_SECONDARY)} ${formatTimeLabel(last.arrival)} ${last.destination}`;
  const metaLine = `${formatDuration(legSchedule.totalDurationMin)} &middot; ${stopsLabelFor(legSchedule)}`;
  return section1(
    `<mj-text padding="0">
      ${legLabelHtml}
      <div style="font-size:12px;color:${COLOR_TEXT_SECONDARY};">${dateLabel}</div>
      <div style="font-size:16px;font-weight:bold;color:${COLOR_TEXT};margin-top:2px;">${routeLine}</div>
      <div style="font-size:13px;color:${COLOR_TEXT_SECONDARY};margin-top:2px;">${metaLine}</div>
    </mj-text>`,
    `padding-bottom="12px"`
  );
}

// origin/destination: { code, name } for the outbound direction; swapped for
// the return leg since the plane is flying the other way.
function buildTripLayoutMjml(best, isRoundtrip, schedule, origin, destination) {
  if (!isRoundtrip) {
    return buildLegRowMjml(null, formatDateLabel(best.fecha_salida), schedule?.out, origin, destination);
  }
  const departBlock = buildLegRowMjml("Ida", formatDateLabel(best.fecha_salida), schedule?.out, origin, destination);
  const returnBlock = buildLegRowMjml("Vuelta", formatDateLabel(best.fecha_vuelta), schedule?.in, destination, origin);
  const divider = section1(`<mj-divider border-width="1px" border-style="dashed" border-color="#eeeeee" padding="0" />`, `padding="0 0 12px 0"`);
  return `${departBlock}${divider}${returnBlock}`;
}

function vsAvgBadgeHtml(vsAvgPercent) {
  if (vsAvgPercent == null) return "";
  const down = vsAvgPercent <= 0;
  const color = down ? COLOR_SUCCESS : COLOR_DANGER;
  return `<span style="font-size:14px;font-weight:700;color:${color};margin-left:8px;white-space:nowrap;">${down ? "↘" : "↗"} ${vsAvgPercent > 0 ? "+" : ""}${vsAvgPercent}%</span>`;
}

// The original scraped currency is always the primary figure (it's the
// price you'd actually be charged); the converted figure underneath is just
// a reference, regardless of who's reading the email.
function buildPriceBlockHtml(priceLabel, brlToArsRate, vsAvgPercent, value) {
  const trendBadge = vsAvgBadgeHtml(vsAvgPercent);
  if (!brlToArsRate) {
    return `<div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${priceLabel}${trendBadge}</div>`;
  }
  const isBRL = priceLabel.startsWith("R$");
  const convertedValue = isBRL ? value * brlToArsRate : value / brlToArsRate;
  const convertedLabel = formatMoney(convertedValue, isBRL ? "ARS" : "BRL");
  return `
    <div style="font-size:28px;color:${COLOR_TEXT};font-weight:bold;">${priceLabel}${trendBadge}</div>
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

// Shared card shell (accent top border, header with route+trip tag+airline,
// trip layout, an optional note/extra row, then price and a full-width CTA
// button below it) used by the summary route cards, the Google Flights
// section and the alert cards -- the three previously had this structure
// copy-pasted three times. No pin icon on the route title (see design doc
// §5 -- the arrow in the route label already shows direction).
function buildTripCardMjml({ ruta, isRoundtrip, airlineHtml, legsMjml, noteHtml, extraMjml, priceBlockHtml, ctaLink, ctaLabel, accentColor }) {
  const headerRow = section1(
    `<mj-text padding="0">
      <div style="font-size:18px;color:${COLOR_TEXT};font-weight:bold;">${ruta}</div>
      <div style="margin-top:8px;">${buildTripTypeTag(isRoundtrip)} <span style="margin-left:4px;">${airlineHtml}</span></div>
    </mj-text>`,
    `padding-bottom="12px"`
  );
  const noteRow = noteHtml ? section1(`<mj-text padding="0">${noteHtml}</mj-text>`, `padding-bottom="8px"`) : "";
  const priceRow = section1(
    `<mj-text padding="0">${priceBlockHtml}</mj-text>`,
    `border-top="1px solid ${COLOR_BORDER}" padding-top="16px"`
  );
  // CTA button gets its own full-width row (not a narrow side column) --
  // see note on mjSection helpers above.
  const ctaRow = ctaLink
    ? section1(
        `<mj-button href="${ctaLink}" background-color="${COLOR_PRIMARY}" color="#ffffff" font-size="14px" font-weight="600" border-radius="${RADIUS_BUTTON}" padding="0" inner-padding="10px 18px" align="left">${ctaLabel}</mj-button>`,
        `padding-top="12px"`
      )
    : "";

  return `<mj-wrapper border="1px solid ${COLOR_BORDER}" border-top="4px solid ${accentColor}" border-radius="${RADIUS_CARD}" padding="16px" background-color="${COLOR_SURFACE}">
    ${headerRow}
    ${legsMjml}
    ${noteRow}
    ${extraMjml || ""}
    ${priceRow}
    ${ctaRow}
  </mj-wrapper>${CARD_SPACER}`;
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

  let mjml = "";
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
    const vsAvgPercent = stats && stats.avg ? Math.round(((best.__value - stats.avg) / stats.avg) * 100) : null;

    summary.routes.push({
      shortLabel: `${best.origen} → ${best.destino}`,
      price: best.mejor_precio,
      site: best.mejor_sitio,
      link,
      isRoundtrip,
      vsAvgPercent,
    });

    mjml += buildTripCardMjml({
      ruta,
      isRoundtrip,
      airlineHtml: buildAirlineInlineHtml(best.mejor_sitio),
      legsMjml: buildTripLayoutMjml(best, isRoundtrip, schedule, originInfo, destinationInfo),
      noteHtml: `${badgeHtml}${deltaHtml}`,
      priceBlockHtml: buildPriceBlockHtml(best.mejor_precio, brlToArsRate, vsAvgPercent, best.__value),
      ctaLink: link,
      ctaLabel: "Ver y comprar",
      accentColor,
    });
  }
  const finalMjml = mjml || section1(`<mj-text padding="0"><p style="font-family:${FONT_STACK};color:${COLOR_TEXT_SECONDARY};">Todavía no encontramos precios para estas rutas.</p></mj-text>`);
  return { html: finalMjml, summary };
}

function buildDashboardRouteBoxMjml(route) {
  const trendHtml =
    route.vsAvgPercent == null
      ? `<div style="font-size:13px;color:${COLOR_TEXT_SECONDARY};">— vs promedio</div>`
      : `<div style="font-size:13px;font-weight:600;color:${route.vsAvgPercent <= 0 ? COLOR_SUCCESS : COLOR_DANGER};">${route.vsAvgPercent <= 0 ? "↘" : "↗"} ${route.vsAvgPercent > 0 ? "+" : ""}${route.vsAvgPercent}% vs promedio</div>`;
  const info = airlineInfoFor(route.site);
  const airlineBadge = buildAirlineBadgeHtml(info.name, info.iata, info.color);
  const tripTypeLabel = `<div style="font-size:11px;color:${COLOR_TEXT_SECONDARY};margin-bottom:2px;">${route.isRoundtrip ? "Ida y vuelta" : "Solo ida"}</div>`;

  const inner = `
    <div style="font-size:13px;color:${COLOR_TEXT_SECONDARY};padding-bottom:2px;">${route.shortLabel}</div>
    ${tripTypeLabel}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="65%" style="font-size:20px;color:${COLOR_TEXT};font-weight:bold;">${route.price}</td>
      <td width="35%" style="text-align:right;vertical-align:middle;">${airlineBadge}</td>
    </tr></table>
    ${trendHtml}`;

  const content = route.link
    ? `<a href="${route.link}" style="text-decoration:none;color:inherit;display:block;">${inner}</a>`
    : inner;
  return `<mj-column width="50%" padding="4px" border="1px solid ${COLOR_BORDER}" border-radius="${RADIUS_CARD}" background-color="${COLOR_SURFACE}"><mj-text padding="12px">${content}</mj-text></mj-column>`;
}

// Two boxes per row via <mj-column> (stacks to one per row automatically on
// narrow screens instead of squeezing, unlike the old fixed-width <table>).
// This simple 2-plain-text-column shape renders correctly across clients
// (confirmed on-device), unlike the 3-column/button-in-column shapes above.
function buildDashboardBoxesMjml(routeList) {
  if (!routeList.length) return "";
  const rows = [];
  for (let i = 0; i < routeList.length; i += 2) {
    const pair = routeList.slice(i, i + 2);
    const secondColumn = pair[1] ? buildDashboardRouteBoxMjml(pair[1]) : mjColumn(50, "");
    rows.push(mjSection(buildDashboardRouteBoxMjml(pair[0]) + secondColumn, `padding-bottom="8px"`));
  }
  return rows.join("");
}

// Small monochrome line icons (tabler-icons style, no emoji) for the
// aggregate stats row, kept deliberately subtle -- this block is meta-info
// about the run, not the headline content.
const ICON_ROUTE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${COLOR_TEXT_SECONDARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4M6 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>`;
const ICON_GLOBE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${COLOR_TEXT_SECONDARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>`;
const ICON_TROPHY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${COLOR_ACCENT_TEXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21l8 0"/><path d="M12 17l0 4"/><path d="M7 4l10 0"/><path d="M17 4v8a5 5 0 0 1 -10 0v-8"/><path d="M5 9a2 2 0 0 1 -2 -2v-1a1 1 0 0 1 1 -1h2"/><path d="M19 9a2 2 0 0 0 2 -2v-1a1 1 0 0 0 -1 -1h-2"/></svg>`;
const ICON_TREND_DOWN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${COLOR_SUCCESS}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l6 6l4 -4l8 8"/><path d="M21 10l0 7l-7 0"/></svg>`;

// Pill-shaped chip (icon + text) instead of loose text lines -- reads as a
// set of small tags rather than a block of paragraph text.
function buildStatChipHtml(iconSvg, text) {
  return `<span style="display:inline-block;background:${COLOR_SURFACE};border:1px solid ${COLOR_BORDER};border-radius:${RADIUS_PILL};padding:6px 12px;margin:0 8px 8px 0;white-space:nowrap;"><span style="display:inline-block;vertical-align:middle;">${iconSvg}</span> <span style="font-size:13px;color:${COLOR_TEXT_SECONDARY};vertical-align:middle;margin-left:4px;">${text}</span></span>`;
}

// Summary block at the top of the email: one clickable box per route (price +
// vs-historical-average trend + airline badge), then the aggregate stats
// below as chips -- deliberately subtle so it reads as meta-info, not
// competing with the actual price cards.
function buildDashboardHtml(summary) {
  const boxesMjml = buildDashboardBoxesMjml(summary.routes);

  const chips = [
    buildStatChipHtml(ICON_ROUTE, `${summary.routesCount} rutas analizadas`),
    buildStatChipHtml(ICON_GLOBE, `${summary.sites.size} sitios consultados`),
  ];
  if (summary.newMinCount > 0) {
    chips.push(buildStatChipHtml(ICON_TROPHY, `${summary.newMinCount} nuevos mínimos históricos`));
  }
  if (summary.droppedCount > 0) {
    chips.push(buildStatChipHtml(ICON_TREND_DOWN, `${summary.droppedCount} precios bajaron`));
  }

  return `<mj-wrapper background-color="${COLOR_BG}" border-radius="${RADIUS_CARD}" padding="16px">
    ${boxesMjml}
    ${section1(`<mj-text padding="0">${chips.join("")}</mj-text>`)}
  </mj-wrapper>${CARD_SPACER}`;
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
  let cardsMjml = "";
  const today = new Date().toISOString().slice(0, 10);

  for (const route of googleFlightsRoutes) {
    // Same "only what's still buyable" rule as summary.js: skip entries for
    // dates that have already passed or predate the route's fromDate (stale
    // history left over from before fromDate existed in config/routes.json).
    // Among the remaining candidates, keep the one scraped most recently.
    let stats = null;
    let departISO = null;
    let returnISO = null;
    let bestScrapedAt = null;
    for (const [key, s] of historyStats) {
      const [routeId, depart, ret, site] = key.split("|");
      if (routeId !== route.id || site !== "googleflights") continue;
      if (depart < today) continue;
      if (route.fromDate && depart < route.fromDate) continue;
      if (route.toDate && depart > route.toDate) continue;
      const scrapedAt = s.history[s.history.length - 1].scraped_at;
      if (!bestScrapedAt || scrapedAt > bestScrapedAt) {
        stats = s;
        departISO = depart;
        returnISO = ret;
        bestScrapedAt = scrapedAt;
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
    const airlineColor = iata ? accentColorForIata(iata) : COLOR_TEXT_SECONDARY;
    const logoHtml = `${buildAirlineBadgeHtml(airlineName, iata, airlineColor)} <span style="font-size:13px;color:${COLOR_TEXT_SECONDARY};">${airlineName}</span>`;
    const vsAvgPercent = stats.avg ? Math.round(((stats.latestPrice - stats.avg) / stats.avg) * 100) : null;

    const isBueGroup = BUE_AIRPORT_CODES.has(route.origin);
    const ruta = isBueGroup ? `Buenos Aires → ${destinationLabelFor(route.label)}` : route.label;
    const originInfo = {
      code: route.origin,
      name: isBueGroup ? BUE_AIRPORT_NAMES[route.origin] || route.origin : originLabelFor(route.label),
    };
    const destinationInfo = { code: route.destination, name: destinationLabelFor(route.label) };

    const priceFormatted = formatMoney(stats.latestPrice, stats.currency);
    const fakeBest = { fecha_salida: isoToDDMMYYYY(departISO), fecha_vuelta: isoToDDMMYYYY(returnISO) };
    const link = schedule?.link || null;
    const accentColor = accentColorForIata(iata);

    cardsMjml += buildTripCardMjml({
      ruta,
      isRoundtrip: true,
      airlineHtml: logoHtml,
      legsMjml: buildTripLayoutMjml(fakeBest, true, schedule, originInfo, destinationInfo),
      noteHtml: "",
      priceBlockHtml: buildPriceBlockHtml(priceFormatted, brlToArsRate && stats.currency === "BRL" ? brlToArsRate : null, vsAvgPercent, stats.latestPrice),
      ctaLink: link,
      ctaLabel: "Ver en Google Flights",
      accentColor,
    });
  }

  if (!cardsMjml) return "";

  const updatedLabel = latestScrapedAt ? `actualizado hoy a las ${formatUpdatedAt(latestScrapedAt)}` : "";
  return `${section1(`<mj-text padding="0"><h3 style="${SECTION_HEADING_STYLE}">Todas las aerolíneas (Google Flights)</h3><p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin:0 0 16px;">Foto de una vez al día${updatedLabel ? ", " + updatedLabel : ""} — incluye aerolíneas que no monitoreamos en vivo (LATAM y otras).</p></mj-text>`)}
    ${cardsMjml}`;
}

const PERSON_NAMES = { pablo: "Pablo", david: "David", jessica: "Jessica" };
const BRAND_NAME = "Chebora";

// Priority: a new historical low is always the headline, even if other prices
// rose elsewhere; otherwise, any price drop is worth a look; otherwise it's
// just a routine update with nothing actionable. No emoji (see
// design/email-design-system.md §6) -- the "Chebora:" prefix identifies the
// mail at a glance in the inbox instead.
function buildSubject(summary, prefix, name) {
  if (summary.newMinCount > 0) return `${prefix}${BRAND_NAME}: nuevo mínimo histórico — resumen de hoy para ${name}`;
  if (summary.droppedCount > 0) return `${prefix}${BRAND_NAME}: bajaron precios — resumen de hoy para ${name}`;
  return `${prefix}${BRAND_NAME}: resumen de hoy para ${name}`;
}

const SITE_URL = "https://pablonicolasacevedo.github.io/vuelos-tracker/";

// Builds the full MJML document (page background, wordmark + title, dashboard,
// body, footer) and compiles it to HTML. Using MJML instead of a hand-written
// <table>-based shell means the viewport meta tag and per-client media
// queries come from the compiler instead of being maintained by hand.
// Forces light mode via the color-scheme meta tags: without them, Gmail's
// mobile app dark-mode "smart" recoloring inverts backgrounds/borders and
// wrecks the deliberately-picked card colors (accent bars, price, CTA).
async function wrapEmail(title, dashboardMjml, bodyMjml, { attachmentNote = true } = {}) {
  // Wordmark (fixed brand lockup) separated from the section title
  // (variable per email) -- see design/BRAND.md. Title/attachment-note/
  // link/footer are plain text blocks (no card background needed), so
  // they're top-level sections rather than mj-wrapper -- MJML doesn't allow
  // nesting mj-wrapper inside mj-wrapper, and the dashboard/route/alert
  // cards below are each their own wrapper.
  const titleSection = section1(
    `<mj-text padding="0">
      <div style="font-family:${WORDMARK_FONT};font-weight:800;font-size:22px;letter-spacing:-0.02em;color:${COLOR_PRIMARY};">${BRAND_NAME} <span style="font-weight:500;font-size:14px;color:${COLOR_TEXT_SECONDARY};letter-spacing:0;">Tracker</span></div>
      <h2 style="margin:8px 0 0;font-size:20px;font-weight:700;color:${COLOR_TEXT};">${title}</h2>
    </mj-text>`,
    `padding="24px 16px 0 16px"`
  );
  const attachmentSection = attachmentNote
    ? section1(
        `<mj-text padding="0"><p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:24px;">Adjunto: detalle día por día de todas las fechas y aerolíneas (se abre con Excel o Google Sheets).</p></mj-text>`,
        `padding="0 16px"`
      )
    : "";
  const linkSection = section1(
    `<mj-text padding="0"><p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:16px;">Todas las rutas y fechas, con gráficos de evolución de precio: <a href="${SITE_URL}" style="color:${COLOR_PRIMARY};">${SITE_URL}</a></p></mj-text>`,
    `padding="0 16px"`
  );
  const footerSection = section1(
    `<mj-text padding="0"><p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin-top:16px;">Generado automáticamente por ${BRAND_NAME}.</p></mj-text>`,
    `padding="0 16px 24px 16px"`
  );

  const source = `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="${FONT_STACK}" />
    </mj-attributes>
    <mj-raw><meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light only" /></mj-raw>
    <mj-font name="Plus Jakarta Sans" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" />
  </mj-head>
  <mj-body background-color="${COLOR_BG}" width="600px">
    ${titleSection}
    ${dashboardMjml}
    ${bodyMjml}
    ${attachmentSection}
    ${linkSection}
    ${footerSection}
  </mj-body>
</mjml>`;

  const { html, errors } = await mjml2html(source);
  if (errors && errors.length) console.error("MJML errors:", JSON.stringify(errors));
  return html;
}

// Compact card for the alert email: same visual language as the summary
// cards (accent bar, trip layout, price block, CTA) plus a badge explaining
// why this price triggered an alert.
function buildAlertCardHtml(alert, brlToArsRate) {
  const { route, site, departDate, returnDate, price, currency, stats, reasons } = alert;
  const isRoundtrip = Boolean(returnDate);

  const isBueGroup = BUE_AIRPORT_CODES.has(route.origin);
  const ruta = isBueGroup ? `Buenos Aires → ${destinationLabelFor(route.label)}` : route.label;
  const originInfo = {
    code: route.origin,
    name: isBueGroup ? BUE_AIRPORT_NAMES[route.origin] || route.origin : originLabelFor(route.label),
  };
  const destinationInfo = { code: route.destination, name: destinationLabelFor(route.label) };

  let link;
  if (site === "googleflights") {
    try {
      link = JSON.parse(stats.latestNotes || "{}").link || null;
    } catch {
      link = null;
    }
  } else {
    link = buildBookingLink(site, {
      origin: route.origin,
      destination: route.destination,
      departISO: departDate,
      returnISO: returnDate,
    });
  }

  const schedule = parseSchedule(stats, site);
  const fakeBest = { fecha_salida: isoToDDMMYYYY(departDate), fecha_vuelta: isoToDDMMYYYY(returnDate) };
  const vsAvgPercent = stats.avg ? Math.round(((price - stats.avg) / stats.avg) * 100) : null;
  const priceFormatted = formatMoney(price, currency);

  const reasonsHtml = reasons
    .map(
      (r) =>
        `<span style="display:inline-block;background:${COLOR_ACCENT_BG};color:${COLOR_ACCENT_TEXT};font-size:13px;font-weight:600;padding:4px 10px;border-radius:${RADIUS_PILL};margin:0 6px 6px 0;">${r.label}</span>`
    )
    .join("");
  const siblingCount = alert.siblings?.length || 0;
  const siblingsNote = siblingCount
    ? `<div style="font-size:13px;color:${COLOR_TEXT_SECONDARY};margin-top:4px;">${
        siblingCount === 1 ? "Otra fecha de esta ruta también disparó la alerta" : `Otras ${siblingCount} fechas de esta ruta también dispararon la alerta`
      } — mirá el sitio para compararlas.</div>`
    : "";
  const extraMjml = section1(`<mj-text padding="0">${reasonsHtml}${siblingsNote}</mj-text>`, `padding-bottom="8px"`);

  const accentColor = airlineInfoFor(site).color;
  return buildTripCardMjml({
    ruta,
    isRoundtrip,
    airlineHtml: buildAirlineInlineHtml(site),
    legsMjml: buildTripLayoutMjml(fakeBest, isRoundtrip, schedule, originInfo, destinationInfo),
    noteHtml: "",
    extraMjml,
    priceBlockHtml: buildPriceBlockHtml(priceFormatted, brlToArsRate && currency === "BRL" ? brlToArsRate : null, vsAvgPercent, price),
    ctaLink: link,
    ctaLabel: "Ver y comprar",
    accentColor,
  });
}

const MAX_ALERT_CARDS = 5;

// Sends one short email per person containing only the trip options that
// triggered an alert this run (see lib/alerts.js). In test runs everything
// goes to Pablo only, with a [TEST] subject prefix, mirroring
// sendSummaryEmails' behavior.
async function sendAlertEmails(alerts) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el envío de alertas.");
    return;
  }
  const recipients = { pablo: process.env.PABLO_EMAIL, david: process.env.DAVID_EMAIL, jessica: process.env.JESSICA_EMAIL };
  const isTestRun = process.env.IS_TEST_RUN === "true";
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const brlToArsRate = await getRate("BRL", "ARS");

  const byPerson = new Map();
  for (const alert of alerts) {
    const person = isTestRun ? "pablo" : alert.person;
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person).push(alert);
  }

  for (const [person, personAlerts] of byPerson) {
    const to = recipients[person];
    if (!to) {
      console.log(`Email de ${person} no configurado: se saltan sus alertas.`);
      continue;
    }
    const top = personAlerts.slice(0, MAX_ALERT_CARDS);
    const first = top[0];
    const extra = personAlerts.length - 1;
    const subject = `${isTestRun ? "[TEST] " : ""}${BRAND_NAME}: ${first.route.origin} → ${first.route.destination} a ${formatMoney(first.price, first.currency)}${extra > 0 ? ` y ${extra} más` : ""}`;

    const cardsMjml = top.map((alert) => buildAlertCardHtml(alert, brlToArsRate)).join("");
    const intro = section1(
      `<mj-text padding="0"><p style="font-size:15px;color:${COLOR_TEXT_SECONDARY};margin:0 0 16px;">${
        top.length === 1 ? "Encontramos una oferta que vale la pena mirar:" : `Encontramos ${personAlerts.length} ofertas que valen la pena mirar:`
      }</p></mj-text>`
    );

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      html: await wrapEmail("Alerta de precio", "", intro + cardsMjml, { attachmentNote: false }),
    });
    console.log(`Alerta enviada a ${person} (${top.length} tarjetas)`);
  }
}

const ANNOUNCEMENT_PATH = path.join(DATA_DIR, "announcement-sent.json");

// One-shot "what's new" block, shown at the top of the next real digest email
// after these features shipped, then never again (data/announcement-sent.json
// is the marker, committed by the digest workflow).
function buildAnnouncementHtml() {
  return `<mj-wrapper background-color="${COLOR_INFO_BG}" border="1px solid ${COLOR_BORDER}" border-radius="${RADIUS_CARD}" padding="16px">
    ${section1(`<mj-text padding="0">
      <div style="font-size:16px;font-weight:bold;color:${COLOR_TEXT};margin-bottom:8px;">Novedades en ${BRAND_NAME}</div>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:${COLOR_TEXT_SECONDARY};line-height:1.6;">
        <li><strong>Sitio web:</strong> <a href="${SITE_URL}" style="color:${COLOR_PRIMARY};">${SITE_URL}</a> — buscador con todas las rutas y fechas que scrapeamos, precios actuales por sitio y gráficos de evolución histórica del precio. Se actualiza solo, varias veces al día.</li>
        <li><strong>Scraping más frecuente:</strong> Aerolíneas se consulta cada 3 horas y Gol/Google Flights varias veces al día, así los datos están más frescos.</li>
        <li><strong>Este resumen diario</strong> sigue llegando una vez por día como hasta ahora, pero ahora es un resguardo: la novedad es el punto siguiente.</li>
        <li><strong>Alertas de precio:</strong> además de este resumen diario, ahora te avisamos apenas encontramos una oferta que realmente vale la pena (nuevo mínimo histórico, precio muy por debajo del promedio, o una caída fuerte) — sin esperar al resumen del día siguiente.</li>
      </ul>
    </mj-text>`)}
  </mj-wrapper>${CARD_SPACER}`;
}

function markAnnouncementSent() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ANNOUNCEMENT_PATH, JSON.stringify({ sent_at: new Date().toISOString() }, null, 2) + "\n");
}

const RECIPIENT_ENV = { pablo: "PABLO_EMAIL", david: "DAVID_EMAIL", jessica: "JESSICA_EMAIL" };
const SUMMARY_EMAIL_CONFIG = {
  pablo: { title: "Precios de vuelos a Brasil — Octubre", csvFile: "resumen-pablo.csv", attachmentName: "detalle-octubre.csv" },
  david: { title: "Precios de vuelos a Brasil — Diciembre a Febrero", csvFile: "resumen-david.csv", attachmentName: "detalle-diciembre-febrero.csv" },
  jessica: { title: "Precios de vuelos a Brasil — Julio y Agosto", csvFile: "resumen-jessica.csv", attachmentName: "detalle-julio-agosto.csv" },
};

// Onboarding block explaining how the tracker works, shown once at the top
// of a new person's very first email (see sendWelcomeEmail below).
function buildOnboardingHtml(name) {
  return `<mj-wrapper background-color="${COLOR_INFO_BG}" border="1px solid ${COLOR_BORDER}" border-radius="${RADIUS_CARD}" padding="16px">
    ${section1(`<mj-text padding="0">
      <div style="font-size:16px;font-weight:bold;color:${COLOR_TEXT};margin-bottom:8px;">¡Bienvenida, ${name}!</div>
      <p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin:0 0 8px;line-height:1.6;">Este es tu tracker de precios de vuelos, ${BRAND_NAME}. Así funciona:</p>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:${COLOR_TEXT_SECONDARY};line-height:1.6;">
        <li><strong>Resumen diario:</strong> una vez por día (a primera hora) te llega un email como este con el mejor precio encontrado para cada una de tus rutas, más un CSV adjunto con el detalle día por día.</li>
        <li><strong>Alertas de precio:</strong> además, apenas encontramos una oferta que vale la pena (nuevo mínimo histórico, precio muy por debajo del promedio, o una caída fuerte) te llega un email aparte, sin esperar al resumen del día siguiente.</li>
        <li><strong>Sitio web:</strong> <a href="${SITE_URL}" style="color:${COLOR_PRIMARY};">${SITE_URL}</a> — ahí podés ver todas tus rutas y fechas, precios actuales por aerolínea y gráficos de evolución histórica. Se actualiza solo varias veces al día.</li>
      </ul>
      <p style="font-size:14px;color:${COLOR_TEXT_SECONDARY};margin:8px 0 0;line-height:1.6;">Abajo ya te dejamos tu primer resumen con los precios de hoy.</p>
    </mj-text>`)}
  </mj-wrapper>${CARD_SPACER}`;
}

const WELCOMED_PATH = (person) => path.join(DATA_DIR, `welcomed-${person}.json`);

function markWelcomed(person) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WELCOMED_PATH(person), JSON.stringify({ sent_at: new Date().toISOString() }, null, 2) + "\n");
}

// One-time onboarding email for a newly added person: explains how the
// tracker works, then includes their first real daily resumen so it's
// useful from the very first message, not just an empty intro. Idempotent
// via data/welcomed-<person>.json, mirroring the announcement-sent.json
// pattern above.
async function sendWelcomeEmail(person) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el email de bienvenida.");
    return;
  }
  const config = SUMMARY_EMAIL_CONFIG[person];
  const name = PERSON_NAMES[person];
  const to = process.env[RECIPIENT_ENV[person]];
  if (!config || !name || !RECIPIENT_ENV[person]) {
    console.log(`Persona desconocida: ${person}`);
    return;
  }
  if (!to) {
    console.log(`${RECIPIENT_ENV[person]} no configurado: se salta el email de bienvenida.`);
    return;
  }
  if (fs.existsSync(WELCOMED_PATH(person))) {
    console.log(`Ya se envió el email de bienvenida a ${name}.`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const brlToArsRate = await getRate("BRL", "ARS");
  const historyStats = getHistoryStats();
  const routeIds = buildRouteIdLookup(person);
  const rows = loadSummary(config.csvFile);
  const result = buildRouteCards(rows, brlToArsRate, historyStats, routeIds);

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject: `¡Bienvenida, ${name}! Así funciona ${BRAND_NAME}`,
    html: await wrapEmail(config.title, buildDashboardHtml(result.summary), buildOnboardingHtml(name) + result.html),
    attachments: [{ filename: config.attachmentName, path: path.join(DATA_DIR, config.csvFile) }],
  });
  markWelcomed(person);
  console.log(`Email de bienvenida enviado a ${name}.`);
}

async function sendSummaryEmails() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se salta el envío de emails.");
    return;
  }
  const pabloEmail = process.env.PABLO_EMAIL;
  const davidEmail = process.env.DAVID_EMAIL;
  const jessicaEmail = process.env.JESSICA_EMAIL;
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
  const jessicaRows = loadSummary("resumen-jessica.csv");
  const brlToArsRate = await getRate("BRL", "ARS");
  const subjectPrefix = isTestRun ? "[TEST] " : "";
  const historyStats = getHistoryStats();
  const pabloRouteIds = buildRouteIdLookup("pablo");
  const davidRouteIds = buildRouteIdLookup("david");
  const jessicaRouteIds = buildRouteIdLookup("jessica");

  const pabloResult = buildRouteCards(pabloRows, brlToArsRate, historyStats, pabloRouteIds);
  const davidResult = buildRouteCards(davidRows, brlToArsRate, historyStats, davidRouteIds);
  const jessicaResult = buildRouteCards(jessicaRows, brlToArsRate, historyStats, jessicaRouteIds);
  const googleFlightsHtml = buildGoogleFlightsSectionHtml(historyStats, brlToArsRate);

  // Shown once, in the first real (non-test) digest sent after the
  // site/alerts/frequency changes shipped; data/announcement-sent.json is the
  // one-shot marker.
  const announcementHtml = fs.existsSync(ANNOUNCEMENT_PATH) ? "" : buildAnnouncementHtml();

  // Each person's email only covers their own routes now -- Pablo used to
  // also get David's section (and the Google Flights section, which only
  // covers David's Buenos Aires routes) for oversight, but that's no longer
  // needed.
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: pabloEmail,
    subject: buildSubject(pabloResult.summary, subjectPrefix, PERSON_NAMES.pablo),
    html: await wrapEmail(
      "Precios de vuelos a Brasil — Octubre",
      buildDashboardHtml(pabloResult.summary),
      announcementHtml + pabloResult.html
    ),
    attachments: [{ filename: "detalle-octubre.csv", path: path.join(DATA_DIR, "resumen-pablo.csv") }],
  });

  if (isTestRun) {
    console.log("Modo prueba: se salta el email a David y Jessica");
  } else {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: davidEmail,
      subject: buildSubject(davidResult.summary, "", PERSON_NAMES.david),
      html: await wrapEmail(
        "Precios de vuelos a Brasil — Diciembre a Febrero",
        buildDashboardHtml(davidResult.summary),
        announcementHtml + davidResult.html + googleFlightsHtml
      ),
      attachments: [{ filename: "detalle-diciembre-febrero.csv", path: path.join(DATA_DIR, "resumen-david.csv") }],
    });

    if (jessicaEmail) {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: jessicaEmail,
        subject: buildSubject(jessicaResult.summary, "", PERSON_NAMES.jessica),
        html: await wrapEmail(
          "Precios de vuelos a Brasil — Julio y Agosto",
          buildDashboardHtml(jessicaResult.summary),
          announcementHtml + jessicaResult.html
        ),
        attachments: [{ filename: "detalle-julio-agosto.csv", path: path.join(DATA_DIR, "resumen-jessica.csv") }],
      });
    } else {
      console.log("JESSICA_EMAIL no configurado: se salta su email.");
    }

    if (announcementHtml) markAnnouncementSent();
  }

  console.log(isTestRun ? "Email enviado (solo a Pablo, modo prueba)" : "Emails enviados a Pablo, David y Jessica");
}

module.exports = { sendSummaryEmails, sendAlertEmails, sendWelcomeEmail };
