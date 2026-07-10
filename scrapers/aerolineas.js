const { chromium } = require("playwright-extra");
chromium.use(require("puppeteer-extra-plugin-stealth")());

const { addDaysToISO } = require("../lib/dates");

const BASE_URL = "https://www.aerolineas.com.ar/pt-br/flex-dates-calendar";
const STAY_NIGHTS_FOR_ANCHOR = 10;

function pad(n) {
  return String(n).padStart(2, "0");
}

// "YYYY-MM" + an anchor day -> depart on that day, return 10 nights later,
// both as YYYYMMDD. The flex-dates calendar returns a rolling ~16-day window
// starting from the anchor date, NOT the whole month (confirmed: every route
// scraped so far tops out at day 15-16 regardless of month length) -- so one
// query per month only ever covers the first half of it. Two anchors (day 1
// and day 16) are needed to cover a full month.
function monthAnchorDates(monthStr, anchorDay = 1) {
  const [y, m] = monthStr.split("-");
  const depart = `${y}${m}${pad(anchorDay)}`;
  const returnDate = addDaysToISO(`${y}-${m}-${pad(anchorDay)}`, STAY_NIGHTS_FOR_ANCHOR).replace(/-/g, "");
  return { depart, returnDate };
}

const MONTH_ANCHOR_DAYS = [1, 16];

function nextMonthStr(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// The calendar response already includes full segment-level detail (times,
// flight numbers, operating airline, stops) for the offer used to price each
// day -- it's just never read. Pull it out so the email can show it.
function extractSchedule(leg) {
  if (!leg) return null;
  return {
    stops: leg.stops ?? 0,
    totalDurationMin: leg.totalDuration ?? null,
    segments: (leg.segments || []).map((s) => ({
      airline: s.operatingAirline || s.airline,
      flightNumber: s.flightNumber,
      origin: s.origin,
      destination: s.destination,
      departure: s.departure,
      arrival: s.arrival,
    })),
  };
}

async function fetchMonthCalendar(page, origin, destination, monthStr, anchorDay) {
  const { depart, returnDate } = monthAnchorDates(monthStr, anchorDay);
  const url = `${BASE_URL}?adt=1&inf=0&chd=0&flexDates=true&cabinClass=Economy&flightType=ROUND_TRIP&leg=${origin}-${destination}-${depart}&leg=${destination}-${origin}-${returnDate}`;

  let captured = null;
  const handler = async (response) => {
    if (!response.url().includes("/v1/flights/offers")) return;
    try {
      captured = await response.json();
    } catch {
      // ignore non-JSON / failed responses
    }
  };
  page.on("response", handler);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);
  page.off("response", handler);

  if (!captured) return { outbound: {}, inbound: {}, currency: null };

  const outbound = {};
  for (const offer of captured.calendarOffers?.["0"] || []) {
    if (!offer.soldOut && offer.offerDetails?.fare?.total != null) {
      outbound[offer.departure] = { price: offer.offerDetails.fare.total, schedule: extractSchedule(offer.leg) };
    }
  }
  const inbound = {};
  for (const offer of captured.calendarOffers?.["1"] || []) {
    if (!offer.soldOut && offer.offerDetails?.fare?.total != null) {
      inbound[offer.departure] = { price: offer.offerDetails.fare.total, schedule: extractSchedule(offer.leg) };
    }
  }
  if (process.env.AR_DEBUG) {
    const total0 = captured.calendarOffers?.["0"]?.length || 0;
    const total1 = captured.calendarOffers?.["1"]?.length || 0;
    console.error(
      `[aerolineas debug] month=${monthStr} anchor=${anchorDay} leg0 ${Object.keys(outbound).length}/${total0} leg1 ${Object.keys(inbound).length}/${total1}`
    );
  }
  return { outbound, inbound, currency: captured.searchMetadata?.currency };
}

// routes: array of { id, origin, destination, tripType, months, stayNights }
// Only "roundtrip" is supported (matches config/routes.json: Aerolineas is
// only assigned to David's roundtrip routes). Two API calls per target month
// (anchored day 1 and day 16) cover the whole month for both legs; one extra
// day-1-only call for the month right after the last target month fills in
// returns for late-month departures.
async function run(routes) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  const results = [];

  for (const route of routes) {
    try {
      const lastMonth = route.months[route.months.length - 1];
      const monthsToFetch = [...route.months, nextMonthStr(lastMonth)];

      const outboundPrices = {};
      const inboundPrices = {};
      let currency = "BRL";

      for (const month of monthsToFetch) {
        // The last (buffer) month only ever needs return-leg coverage for
        // early-month dates (depart + stayNights lands there), which the
        // day-1 anchor's window already reaches -- skip the day-16 anchor
        // for it to save a request.
        const isBufferMonth = month === monthsToFetch[monthsToFetch.length - 1] && month !== route.months[route.months.length - 1];
        const anchors = isBufferMonth ? [MONTH_ANCHOR_DAYS[0]] : MONTH_ANCHOR_DAYS;
        for (const anchorDay of anchors) {
          const { outbound, inbound, currency: c } = await fetchMonthCalendar(
            page,
            route.origin,
            route.destination,
            month,
            anchorDay
          );
          Object.assign(outboundPrices, outbound);
          Object.assign(inboundPrices, inbound);
          if (c) currency = c;
        }
      }

      const targetMonths = new Set(route.months);
      for (const [departDate, out] of Object.entries(outboundPrices)) {
        if (!targetMonths.has(departDate.slice(0, 7))) continue;
        if (route.fromDate && departDate < route.fromDate) continue;
        if (route.toDate && departDate > route.toDate) continue;
        const returnDate = addDaysToISO(departDate, route.stayNights);
        const inbound = inboundPrices[returnDate];
        // Schedule detail (times/stops) is only attached on the happy path,
        // when both legs priced -- the single-leg fallback below keeps its
        // plain-text note instead, same as before this change.
        const notes = inbound
          ? JSON.stringify({ out: out.schedule, in: inbound.schedule })
          : "precio de una sola pierna (falta la otra en el calendario)";
        results.push({
          scraped_at: new Date().toISOString(),
          site: "aerolineas",
          route_id: route.id,
          origin: route.origin,
          destination: route.destination,
          depart_date: departDate,
          return_date: returnDate,
          price: inbound ? out.price + inbound.price : out.price,
          currency,
          notes,
        });
      }
    } catch (err) {
      results.push({
        scraped_at: new Date().toISOString(),
        site: "aerolineas",
        route_id: route.id,
        origin: route.origin,
        destination: route.destination,
        depart_date: "",
        return_date: "",
        price: "",
        currency: "",
        notes: `error: ${err.message}`,
      });
    }
  }

  await browser.close();
  return results;
}

module.exports = { run };
