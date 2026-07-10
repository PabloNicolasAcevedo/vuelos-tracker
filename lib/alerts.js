const fs = require("fs");
const path = require("path");
const { getHistoryStats, keyOf } = require("./history");

const routes = require("../config/routes.json");

const STATE_PATH = path.join(__dirname, "..", "data", "alerts-state.json");

// Per-route overrides live in config/routes.json under an optional "alerts"
// field, e.g. { "percentBelowAvg": 20, "absoluteBelow": { "price": 900,
// "currency": "BRL" } }. Anything not overridden falls back to these.
const DEFAULTS = {
  percentBelowAvg: 15, // alert if latest <= avg * (1 - X/100)
  dropPercent: 10, // alert if latest dropped >= X% vs previous run
  cooldownHours: 24, // don't re-alert the same trip option within this window
};
// Within the cooldown window, a further drop of at least this fraction below
// the already-alerted price still gets through (a drop within a drop matters).
const COOLDOWN_BYPASS_DROP = 0.03;
// Averages over fewer points than this aren't meaningful enough to alert on.
const MIN_HISTORY_FOR_AVG = 5;

// Severity rank for sorting cards inside the alert email.
const REASON_RANK = { "new-min": 3, "below-avg": 2, "below-absolute": 2, drop: 1 };

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function routesById() {
  const map = {};
  for (const route of routes) map[route.id] = route;
  return map;
}

function reasonsFor(stats, config) {
  const reasons = [];
  if (stats.isNewHistoricalMin) {
    reasons.push({ type: "new-min", label: "🏆 Nuevo mínimo histórico" });
  }
  if (stats.history.length >= MIN_HISTORY_FOR_AVG && stats.avg) {
    const pctBelowAvg = Math.round((1 - stats.latestPrice / stats.avg) * 100);
    if (pctBelowAvg >= config.percentBelowAvg) {
      reasons.push({ type: "below-avg", label: `${pctBelowAvg}% debajo del promedio histórico` });
    }
  }
  if (stats.previousPrice != null && stats.previousPrice > 0) {
    const dropPct = Math.round((1 - stats.latestPrice / stats.previousPrice) * 100);
    if (dropPct >= config.dropPercent) {
      reasons.push({ type: "drop", label: `Cayó ${dropPct}% desde la última corrida` });
    }
  }
  const abs = config.absoluteBelow;
  // Same-currency comparison only: converting via the exchange-rate API here
  // would make alert behavior depend on a third-party service being up.
  if (abs && abs.currency === stats.currency && stats.latestPrice <= abs.price) {
    reasons.push({ type: "below-absolute", label: `Debajo de tu tope de ${abs.price} ${abs.currency}` });
  }
  return reasons;
}

// Evaluates this run's freshly scraped rows against the full history and the
// cooldown state. Returns the alerts worth emailing (sorted by severity) and
// the state pruned of past departure dates; the caller persists the state via
// recordAlertsSent() only after the emails actually went out.
function evaluateAlerts(newRows, { now = new Date() } = {}) {
  const byId = routesById();
  const today = now.toISOString().slice(0, 10);
  const state = loadState();

  const prunedState = {};
  for (const [key, entry] of Object.entries(state)) {
    const depart = key.split("|")[1];
    if (depart >= today) prunedState[key] = entry;
  }

  // One evaluation per trip option scraped in this run.
  const seen = new Set();
  const candidates = [];
  for (const row of newRows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.price === "" || row.price == null) continue;
    const route = byId[row.route_id];
    if (!route) continue;
    if (row.depart_date < today) continue;
    if (route.fromDate && row.depart_date < route.fromDate) continue;
    if (route.toDate && row.depart_date > route.toDate) continue;
    candidates.push({ key, row, route });
  }
  if (!candidates.length) return { alerts: [], prunedState };

  const historyStats = getHistoryStats();
  const alerts = [];
  for (const { key, row, route } of candidates) {
    const stats = historyStats.get(key);
    if (!stats) continue;
    const config = { ...DEFAULTS, ...(route.alerts || {}) };
    const reasons = reasonsFor(stats, config);
    if (!reasons.length) continue;

    const prior = prunedState[key];
    if (prior) {
      const withinCooldown = now.getTime() - new Date(prior.lastSentAt).getTime() < config.cooldownHours * 3600 * 1000;
      const droppedFurther = stats.latestPrice <= prior.lastPrice * (1 - COOLDOWN_BYPASS_DROP);
      if (withinCooldown && !droppedFurther) continue;
    }

    alerts.push({
      key,
      siblings: [],
      person: route.person,
      route,
      site: row.site,
      departDate: row.depart_date,
      returnDate: row.return_date || null,
      price: stats.latestPrice,
      currency: stats.currency,
      stats,
      reasons,
      rank: Math.max(...reasons.map((r) => REASON_RANK[r.type] || 0)),
    });
  }

  // A fare sale drops dozens of dates of the same route at once; one card per
  // route+site with the cheapest triggering date (plus a "N fechas más"
  // count) is signal, 40 near-identical cards is noise. The collapsed
  // siblings still enter the cooldown state so the next run doesn't re-alert
  // on a date the user already saw implied by "N fechas más".
  const byGroup = new Map();
  for (const alert of alerts) {
    const groupKey = `${alert.route.id}|${alert.site}`;
    const current = byGroup.get(groupKey);
    if (!current) {
      byGroup.set(groupKey, alert);
    } else if (alert.rank > current.rank || (alert.rank === current.rank && alert.price < current.price)) {
      alert.siblings = [...current.siblings, { key: current.key, price: current.price }];
      byGroup.set(groupKey, alert);
    } else {
      current.siblings.push({ key: alert.key, price: alert.price });
    }
  }

  const collapsed = [...byGroup.values()].sort((a, b) => b.rank - a.rank || a.price - b.price);
  return { alerts: collapsed, prunedState };
}

function recordAlertsSent(alerts, prunedState, { now = new Date() } = {}) {
  const state = { ...prunedState };
  for (const alert of alerts) {
    state[alert.key] = { lastSentAt: now.toISOString(), lastPrice: alert.price };
    for (const sibling of alert.siblings) {
      state[sibling.key] = { lastSentAt: now.toISOString(), lastPrice: sibling.price };
    }
  }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

module.exports = { evaluateAlerts, recordAlertsSent };
