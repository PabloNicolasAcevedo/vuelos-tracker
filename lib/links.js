function toDDMMYYYY(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function golLink({ origin, destination, departISO, returnISO }) {
  const params = new URLSearchParams({
    pv: "br",
    tipo: "DF",
    lang: "pt-BR",
    de: origin,
    para: destination,
    ida: toDDMMYYYY(departISO),
    ADT: "1",
    ADL: "0",
    CHD: "0",
    INF: "0",
    voebiz: "0",
  });
  if (returnISO) params.set("volta", toDDMMYYYY(returnISO));
  return `https://b2c.voegol.com.br/compra/busca-parceiros?${params.toString()}`;
}

function aerolineasLink({ origin, destination, departISO, returnISO }) {
  const compact = (iso) => iso.replace(/-/g, "");
  const legs = [`leg=${origin}-${destination}-${compact(departISO)}`];
  let flightType = "ONE_WAY";
  if (returnISO) {
    legs.push(`leg=${destination}-${origin}-${compact(returnISO)}`);
    flightType = "ROUND_TRIP";
  }
  return `https://www.aerolineas.com.ar/pt-br/flex-dates-calendar?adt=1&inf=0&chd=0&flexDates=true&cabinClass=Economy&flightType=${flightType}&${legs.join(
    "&"
  )}`;
}

const LINK_BUILDERS = { gol: golLink, aerolineas: aerolineasLink };

function buildBookingLink(site, params) {
  const builder = LINK_BUILDERS[site];
  if (!builder || !params.departISO) return null;
  try {
    return builder(params);
  } catch {
    return null;
  }
}

module.exports = { buildBookingLink };
