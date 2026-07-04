const gol = require("./gol");
const { datePairFromConfig } = require("../lib/dates");

(async () => {
  const pair = datePairFromConfig("2026-10", 10, 7);
  const routes = [
    {
      id: "bue-gyn",
      origin: "EZE",
      destination: "GYN",
      datePairs: [{ departISO: pair.departISO, returnISO: pair.returnISO }],
    },
  ];
  const results = await gol.run(routes);
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});
