const { addDaysToISO } = require("../lib/dates");

const BASE_URL = "https://serpapi.com/search.json";

// Extracts the same {stops, totalDurationMin, segments} shape used by
// scrapers/aerolineas.js, so lib/email.js's existing schedule rendering
// (buildTripLayoutHtml, parseSchedule) works for this site without changes.
function extractSchedule(flightOption) {
  const legs = flightOption.flights || [];
  if (!legs.length) return null;
  return {
    stops: legs.length - 1,
    totalDurationMin: flightOption.total_duration ?? null,
    segments: legs.map((leg) => ({
      airline: leg.airline,
      flightNumber: leg.flight_number,
      origin: leg.departure_airport.id,
      destination: leg.arrival_airport.id,
      departure: leg.departure_airport.time.replace(" ", "T"),
      arrival: leg.arrival_airport.time.replace(" ", "T"),
    })),
  };
}

// One SerpApi call per route returns the round-trip price already combined
// with the outbound schedule; getting the return leg's schedule too needs a
// second call with departure_token, which we skip to keep this at 1
// call/route/day (~120/month across 4 routes, well under the 250 free tier).
async function fetchCheapestRoundtrip(apiKey, origin, destination, departDate, returnDate) {
  const url = `${BASE_URL}?engine=google_flights&departure_id=${origin}&arrival_id=${destination}&outbound_date=${departDate}&return_date=${returnDate}&type=1&currency=BRL&hl=en&api_key=${apiKey}`;
  const response = await fetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error);

  const options = [...(json.best_flights || []), ...(json.other_flights || [])];
  if (!options.length) return null;

  options.sort((a, b) => a.price - b.price);
  return { option: options[0], googleFlightsUrl: json.search_metadata?.google_flights_url || null };
}

// routes: array of { id, origin, destination, months, stayNights } (roundtrip only)
async function run(routes) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.log("SERPAPI_KEY no configurado: se salta Google Flights.");
    return [];
  }

  const results = [];
  for (const route of routes) {
    const departDate = `${route.months[0]}-01`;
    const returnDate = addDaysToISO(departDate, route.stayNights);

    try {
      const found = await fetchCheapestRoundtrip(apiKey, route.origin, route.destination, departDate, returnDate);
      if (!found) {
        results.push({
          scraped_at: new Date().toISOString(),
          site: "googleflights",
          route_id: route.id,
          origin: route.origin,
          destination: route.destination,
          depart_date: departDate,
          return_date: returnDate,
          price: "",
          currency: "BRL",
          notes: "sin resultados",
        });
        continue;
      }

      const schedule = { out: extractSchedule(found.option), in: null, link: found.googleFlightsUrl };
      results.push({
        scraped_at: new Date().toISOString(),
        site: "googleflights",
        route_id: route.id,
        origin: route.origin,
        destination: route.destination,
        depart_date: departDate,
        return_date: returnDate,
        price: found.option.price,
        currency: "BRL",
        notes: JSON.stringify(schedule),
      });
    } catch (err) {
      results.push({
        scraped_at: new Date().toISOString(),
        site: "googleflights",
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

  return results;
}

module.exports = { run };
