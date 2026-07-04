// Free, no-API-key exchange rate lookup. Returns null (never throws) if the
// service is unreachable, so a network hiccup never breaks the email send.
async function getRate(base, target) {
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.rates?.[target] ?? null;
  } catch {
    return null;
  }
}

module.exports = { getRate };
