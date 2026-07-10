/* global Chart */
(() => {
  const SITE_LABELS = {
    gol: "Gol",
    aerolineas: "Aerolíneas Argentinas",
    googleflights: "Google Flights",
  };
  // Fixed categorical order (never cycled): each site always keeps its color.
  const SITE_COLORS = {
    gol: cssVar("--series-gol"),
    aerolineas: cssVar("--series-aerolineas"),
    googleflights: cssVar("--series-googleflights"),
  };

  const state = {
    index: null,
    route: null, // route JSON currently loaded
    optionIdx: 0,
    historyChart: null,
    datesChart: null,
  };

  const $route = document.getElementById("route-select");
  const $date = document.getElementById("date-select");

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fmtMoney(value, currency) {
    const locales = { BRL: "pt-BR", ARS: "es-AR", USD: "en-US" };
    return new Intl.NumberFormat(locales[currency] || "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  }

  function fmtARS(value, currency) {
    const rate = state.index.brl_ars_rate;
    if (currency !== "BRL" || !rate) return "—";
    return fmtMoney(value * rate, "ARS");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  function fmtAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `hace ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `hace ${hours} h`;
    return `hace ${Math.round(hours / 24)} días`;
  }

  function chartDefaults() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = cssVar("--muted");
    Chart.defaults.borderColor = cssVar("--grid");
  }

  async function init() {
    state.index = await (await fetch("data/index.json")).json();

    document.getElementById("updated-at").textContent =
      `Datos actualizados ${fmtAgo(state.index.generated_at)} · se actualizan automáticamente varias veces al día`;

    for (const route of state.index.routes) {
      const opt = document.createElement("option");
      opt.value = route.id;
      opt.textContent = `${route.label} (${route.origin} → ${route.destination})`;
      $route.appendChild(opt);
    }

    chartDefaults();
    $route.addEventListener("change", () => loadRoute($route.value));
    $date.addEventListener("change", () => {
      state.optionIdx = Number($date.value);
      render();
    });

    await loadRoute(state.index.routes[0].id);
  }

  async function loadRoute(id) {
    state.route = await (await fetch(`data/routes/${id}.json`)).json();

    $date.innerHTML = "";
    state.route.options.forEach((option, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = option.return
        ? `${fmtDate(option.depart)} → vuelta ${fmtDate(option.return)}`
        : fmtDate(option.depart);
      $date.appendChild(opt);
    });

    // Preselect the cheapest date so the page opens on the best deal.
    let bestIdx = 0;
    state.route.options.forEach((option, i) => {
      if (option.best.price < state.route.options[bestIdx].best.price) bestIdx = i;
    });
    state.optionIdx = bestIdx;
    $date.value = String(bestIdx);

    render();
  }

  function render() {
    const option = state.route.options[state.optionIdx];
    renderSummary(option);
    renderTable(option);
    renderHistoryChart(option);
    renderDatesChart();
  }

  function renderSummary(option) {
    const el = document.getElementById("trip-summary");
    const best = option.best;
    const isMin = option.current[best.site].is_historical_min;
    el.classList.remove("hidden");
    el.innerHTML = `
      <div>
        <div class="big">${fmtMoney(best.price, best.currency)}</div>
        <div class="sub">≈ ${fmtARS(best.price, best.currency)} · mejor precio en ${SITE_LABELS[best.site] || best.site}
        ${isMin ? '<span class="badge-min">🏆 Mínimo histórico</span>' : ""}</div>
      </div>
      <div class="sub">
        ${state.route.origin} → ${state.route.destination} · salida ${fmtDate(option.depart)}
        ${option.return ? ` · vuelta ${fmtDate(option.return)}` : " · solo ida"}
      </div>`;
  }

  function renderTable(option) {
    const tbody = document.querySelector("#prices-table tbody");
    tbody.innerHTML = "";
    const sites = Object.keys(option.current).sort(
      (a, b) => option.current[a].price - option.current[b].price
    );
    for (const site of sites) {
      const cur = option.current[site];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="site-cell"><span class="site-dot" style="background:${SITE_COLORS[site] || "#888"}"></span>${SITE_LABELS[site] || site}</span>${
          cur.is_historical_min ? '<span class="badge-min">Mínimo histórico</span>' : ""
        }</td>
        <td class="num">${fmtMoney(cur.price, cur.currency)}</td>
        <td class="num">${fmtARS(cur.price, cur.currency)}</td>
        <td class="muted">${fmtAgo(cur.scraped_at)}</td>
        <td>${cur.link ? `<a class="buy-btn" href="${cur.link}" target="_blank" rel="noopener">Ver y comprar</a>` : ""}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderHistoryChart(option) {
    const ctx = document.getElementById("history-chart");
    if (state.historyChart) state.historyChart.destroy();

    // Union of scrape days across sites, as shared x labels.
    const days = [...new Set(Object.values(option.history).flatMap((h) => h.points.map((p) => p[0])))].sort();
    const datasets = Object.entries(option.history).map(([site, h]) => {
      const byDay = new Map(h.points);
      return {
        label: SITE_LABELS[site] || site,
        data: days.map((d) => byDay.get(d) ?? null),
        borderColor: SITE_COLORS[site] || "#888",
        backgroundColor: SITE_COLORS[site] || "#888",
        borderWidth: 2,
        pointRadius: 3,
        spanGaps: true,
        tension: 0.15,
      };
    });

    state.historyChart = new Chart(ctx, {
      type: "line",
      data: { labels: days.map(fmtDate), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: datasets.length > 1 },
          tooltip: {
            callbacks: {
              label: (item) =>
                ` ${item.dataset.label}: ${fmtMoney(item.parsed.y, option.best.currency)}`,
            },
          },
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmtMoney(v, option.best.currency) },
          },
        },
      },
    });
  }

  function renderDatesChart() {
    const ctx = document.getElementById("dates-chart");
    if (state.datesChart) state.datesChart.destroy();

    const options = state.route.options;
    const currency = options[0].best.currency;
    const color = cssVar("--primary");

    state.datesChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: options.map((o) => fmtDate(o.depart)),
        datasets: [
          {
            label: "Mejor precio actual",
            data: options.map((o) => o.best.price),
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: options.map((_, i) => (i === state.optionIdx ? 6 : 3)),
            tension: 0.15,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          state.optionIdx = elements[0].index;
          $date.value = String(state.optionIdx);
          render();
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const o = options[item.dataIndex];
                return ` ${fmtMoney(o.best.price, o.best.currency)} (${SITE_LABELS[o.best.site] || o.best.site})`;
              },
            },
          },
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmtMoney(v, currency) },
          },
        },
      },
    });
  }

  init().catch((err) => {
    document.getElementById("updated-at").textContent = `Error cargando datos: ${err.message}`;
  });
})();
