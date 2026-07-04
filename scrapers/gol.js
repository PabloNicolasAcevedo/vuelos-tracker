const { chromium } = require("playwright-extra");
chromium.use(require("puppeteer-extra-plugin-stealth")());

const HOME_URL = "https://www.voegol.com.br/nh/home/";

const AIRPORT_HINTS = {
  EZE: "Ezeiza",
  GYN: "Goiânia",
  BSB: "Brasília",
  SCL: "Santiago",
  AEP: "Aeroparque",
  LUQ: "San Luis",
};

async function dismissCookies(page) {
  const rejectCookies = page.locator("text=Reject All").first();
  if (await rejectCookies.isVisible({ timeout: 3000 }).catch(() => false)) {
    await rejectCookies.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function dismissGeoModal(page) {
  await page.evaluate(() => document.getElementById("redirGeo")?.remove()).catch(() => {});
}

async function fillAirport(page, inputId, optionText, code) {
  await page.locator(inputId).click({ timeout: 15000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type(code, { delay: 80 });
  await page.waitForTimeout(1200);
  await page.locator(`text=${optionText}`).first().click({ timeout: 8000 });
  await page.waitForTimeout(400);
}

// Opens the round-trip calendar for origin/destination and clicks "next month"
// enough times to cover every month requested, capturing each flightcalendar
// response along the way. Returns { "YYYY-MM-DD": price }.
async function collectCalendarPrices(page, origin, originHint, destination, destHint, maxMonthIndex) {
  const prices = {};

  page.on("response", async (response) => {
    if (!response.url().includes("flightcalendar")) return;
    try {
      const json = await response.json();
      for (const day of json.calendar || []) {
        if (day.hasFlight) prices[day.data] = day.value;
      }
    } catch {
      // ignore non-JSON / failed responses
    }
  });

  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  await dismissGeoModal(page);
  await dismissCookies(page);

  await fillAirport(page, "#input-saindo-de", originHint, origin);
  await dismissGeoModal(page);
  await fillAirport(page, "#input-indo-para", destHint, destination);
  await dismissGeoModal(page);

  await page.locator("#departureDate").click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  const nextArrow = page.locator("[data-testid='tgr-datepicker-popover__button-foward']").first();
  // Initial load covers months [0,1] (0-indexed from the current month); each
  // "next" click reveals one additional month, and responses accumulate.
  const numClicks = Math.max(0, maxMonthIndex - 1);
  for (let i = 0; i < numClicks; i++) {
    await nextArrow
      .click()
      .then(() => process.env.GOL_DEBUG && console.error(`[gol debug] next-arrow click ${i + 1}/${numClicks} ok`))
      .catch((e) => process.env.GOL_DEBUG && console.error(`[gol debug] next-arrow click ${i + 1} FAILED:`, e.message));
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1500);

  if (process.env.GOL_DEBUG) {
    const days = Object.keys(prices).sort();
    console.error(`[gol debug] ${origin}->${destination} captured ${days.length} days, range ${days[0]}..${days[days.length - 1]}`);
  }

  return prices;
}

// routes: array of { id, origin, destination, datePairs: [{departISO, returnISO}] }
async function run(routes) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  const results = [];

  for (const route of routes) {
    const maxMonthIndex = Math.max(
      ...route.datePairs.flatMap((p) => [monthIndexFromNow(p.departISO), monthIndexFromNow(p.returnISO)])
    );

    try {
      const outboundPrices = await collectCalendarPrices(
        page,
        route.origin,
        AIRPORT_HINTS[route.origin] || route.origin,
        route.destination,
        AIRPORT_HINTS[route.destination] || route.destination,
        maxMonthIndex
      );
      const inboundPrices = await collectCalendarPrices(
        page,
        route.destination,
        AIRPORT_HINTS[route.destination] || route.destination,
        route.origin,
        AIRPORT_HINTS[route.origin] || route.origin,
        maxMonthIndex
      );

      for (const pair of route.datePairs) {
        const outPrice = outboundPrices[pair.departISO];
        const inPrice = inboundPrices[pair.returnISO];
        if (outPrice == null && inPrice == null) continue;
        results.push({
          scraped_at: new Date().toISOString(),
          site: "gol",
          route_id: route.id,
          origin: route.origin,
          destination: route.destination,
          depart_date: pair.departISO,
          return_date: pair.returnISO,
          price: outPrice != null && inPrice != null ? outPrice + inPrice : outPrice ?? inPrice,
          currency: "BRL",
          notes:
            outPrice != null && inPrice != null
              ? ""
              : "precio de una sola pierna (falta la otra en el calendario)",
        });
      }
    } catch (err) {
      results.push({
        scraped_at: new Date().toISOString(),
        site: "gol",
        route_id: route.id,
        origin: route.origin,
        destination: route.destination,
        depart_date: "",
        return_date: "",
        price: "",
        currency: "BRL",
        notes: `error: ${err.message}`,
      });
    }
  }

  await browser.close();
  return results;
}

function monthIndexFromNow(iso) {
  const now = new Date();
  const [y, m] = iso.split("-").map(Number);
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
}

module.exports = { run };
