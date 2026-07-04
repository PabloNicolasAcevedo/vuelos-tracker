function pad(n) {
  return String(n).padStart(2, "0");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toBR(date) {
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

// month: "YYYY-MM", departDay: 1-31, nights: integer
function datePairFromConfig(month, departDay, nights) {
  const [year, mon] = month.split("-").map(Number);
  const depart = new Date(year, mon - 1, departDay);
  const ret = addDays(depart, nights);
  return {
    departISO: toISO(depart),
    returnISO: toISO(ret),
    departBR: toBR(depart),
    returnBR: toBR(ret),
  };
}

// Months between "from" (YYYY-MM, current) and target month, inclusive count needed
// to reach target starting from current calendar month.
function monthsAhead(targetMonth) {
  const now = new Date();
  const [ty, tm] = targetMonth.split("-").map(Number);
  return (ty - now.getFullYear()) * 12 + (tm - (now.getMonth() + 1));
}

module.exports = { datePairFromConfig, monthsAhead, toISO, toBR };
