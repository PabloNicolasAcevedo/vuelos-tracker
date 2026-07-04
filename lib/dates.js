function pad(n) {
  return String(n).padStart(2, "0");
}

// iso: "YYYY-MM-DD" -> "YYYY-MM-DD" shifted by `days`
function addDaysToISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "YYYY-MM-DD" -> "DD/MM/YYYY" (how Pablo/David are used to reading dates)
function isoToDDMMYYYY(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// How many calendar months ahead `monthOrDate` ("YYYY-MM" or "YYYY-MM-DD") is
// from today, 0-indexed (current month = 0).
function monthIndexFromNow(monthOrDate) {
  const now = new Date();
  const [y, m] = monthOrDate.split("-").map(Number);
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
}

module.exports = { addDaysToISO, isoToDDMMYYYY, monthIndexFromNow };
