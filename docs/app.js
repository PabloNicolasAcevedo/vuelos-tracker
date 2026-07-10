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
  const WEEKDAYS = ["D", "L", "M", "M", "J", "V", "S"];
  const MONTH_NAMES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];

  const state = {
    index: null,
    route: null, // route JSON currently loaded
    optionIdx: 0,
    currency: "original", // "original" | "ARS"
    historyChart: null,
    datesChart: null,
    departCalMonth: null, // {y, m} (m = 0-indexed) currently shown in the depart popover
    returnCalMonth: null,
  };

  const $route = document.getElementById("route-select");
  const $departTrigger = document.getElementById("depart-trigger");
  const $returnTrigger = document.getElementById("return-trigger");
  const $departCal = document.getElementById("depart-calendar");
  const $returnCal = document.getElementById("return-calendar");
  const $returnPicker = document.getElementById("return-picker");
  const $themeToggle = document.getElementById("theme-toggle");
  const $currencyToggle = document.getElementById("currency-toggle");

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // --- Theme ---------------------------------------------------------------

  function effectiveTheme() {
    const override = localStorage.getItem("theme");
    if (override) return override;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    $themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
    // Series colors are read from CSS vars at chart-build time, so re-render
    // the charts whenever the palette actually changes.
    if (state.route) {
      renderHistoryChart(state.route.options[state.optionIdx]);
      renderDatesChart();
    }
  }

  function initTheme() {
    applyTheme(effectiveTheme());
    $themeToggle.addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      applyTheme(next);
    });
  }

  // --- Currency --------------------------------------------------------------

  function initCurrencyToggle() {
    state.currency = localStorage.getItem("currency") || "original";
    for (const btn of $currencyToggle.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.currency === state.currency);
      btn.addEventListener("click", () => {
        state.currency = btn.dataset.currency;
        localStorage.setItem("currency", state.currency);
        for (const b of $currencyToggle.querySelectorAll("button")) b.classList.toggle("active", b === btn);
        render();
      });
    }
  }

  // Converts a scraped price into whatever currency the user chose to view
  // everything in; "original" leaves each price in the currency it was
  // actually quoted in (mixing BRL/ARS across sites if that ever happens).
  function displayPrice(value, currency) {
    if (state.currency === "ARS" && currency === "BRL" && state.index.brl_ars_rate) {
      return { value: value * state.index.brl_ars_rate, currency: "ARS" };
    }
    return { value, currency };
  }

  function fmtMoney(value, currency) {
    const locales = { BRL: "pt-BR", ARS: "es-AR", USD: "en-US" };
    return new Intl.NumberFormat(locales[currency] || "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  }

  function fmtDisplay(value, currency) {
    const d = displayPrice(value, currency);
    return fmtMoney(d.value, d.currency);
  }

  // Compact hint for calendar day cells: ARS amounts run 6+ digits (e.g.
  // 473.357) which never fit a 7-column grid, so round to thousands with a
  // "k" suffix instead of truncating/overflowing.
  function fmtCompact(value, currency) {
    const d = displayPrice(value, currency);
    return `${Math.round(d.value / 1000)}k`;
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
  }

  // --- Calendar date pickers -------------------------------------------------
  // Flight-search-style: a button that opens a month grid where only the
  // dates we actually have data for are clickable, each showing its cheapest
  // price as a hint (like Google Flights/Skyscanner's calendar).

  function closeAllCalendars() {
    $departCal.classList.add("hidden");
    $returnCal.classList.add("hidden");
  }

  // Uses composedPath() instead of evt.target.closest(): the month-nav
  // buttons re-render the popover's innerHTML on click (replacing themselves
  // in the DOM), so by the time this bubbles up here evt.target is already
  // detached and .closest() can no longer find its old .datepicker ancestor
  // -- composedPath() captures the path as it was at dispatch time, before
  // any of that mutation happened.
  document.addEventListener("click", (evt) => {
    const path = evt.composedPath ? evt.composedPath() : [];
    const insideDatepicker = path.some((el) => el.classList && el.classList.contains("datepicker"));
    if (!insideDatepicker) closeAllCalendars();
  });

  function monthKey(iso) {
    const [y, m] = iso.split("-").map(Number);
    return { y, m: m - 1 };
  }

  function renderCalendar(container, { dateField, readOnly, monthState, onPick }) {
    const options = state.route.options;
    const withDates = options.filter((o) => o[dateField]);
    if (!withDates.length) {
      container.innerHTML = "";
      return;
    }
    const byDate = new Map(withDates.map((o) => [o[dateField], o]));
    const allMonths = [...new Set(withDates.map((o) => monthKey(o[dateField]).y * 12 + monthKey(o[dateField]).m))].sort(
      (a, b) => a - b
    );
    const minMonth = allMonths[0];
    const maxMonth = allMonths[allMonths.length - 1];

    if (!monthState.current) {
      const selected = options[state.optionIdx];
      monthState.current = selected[dateField] ? monthKey(selected[dateField]) : monthKey(withDates[0][dateField]);
    }
    const { y, m } = monthState.current;
    const monthIdx = y * 12 + m;

    const firstOfMonth = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const startWeekday = firstOfMonth.getDay();

    const selectedDate = options[state.optionIdx][dateField];

    let daysHtml = "";
    for (let i = 0; i < startWeekday; i++) daysHtml += `<div class="cal-day"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const option = byDate.get(iso);
      const classes = ["cal-day"];
      if (option) classes.push("available");
      if (iso === selectedDate) classes.push("selected");
      const priceHtml = option
        ? `<span class="cal-day-price">${fmtCompact(option.best.price, option.best.currency)}</span>`
        : "";
      daysHtml += `<button type="button" class="${classes.join(" ")}" data-iso="${iso}" ${option ? "" : "disabled"}>
        <span class="cal-day-num">${day}</span>${priceHtml}
      </button>`;
    }

    container.innerHTML = `
      <div class="cal-header">
        <button type="button" class="cal-nav" data-dir="-1" ${monthIdx <= minMonth ? "disabled" : ""}>‹</button>
        <span>${MONTH_NAMES[m]} ${y}</span>
        <button type="button" class="cal-nav" data-dir="1" ${monthIdx >= maxMonth ? "disabled" : ""}>›</button>
      </div>
      <div class="cal-weekdays">${WEEKDAYS.map((w) => `<div>${w}</div>`).join("")}</div>
      <div class="cal-days">${daysHtml}</div>`;

    container.querySelector(".cal-nav[data-dir='-1']")?.addEventListener("click", () => {
      monthState.current = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
      renderCalendar(container, { dateField, readOnly, monthState, onPick });
    });
    container.querySelector(".cal-nav[data-dir='1']")?.addEventListener("click", () => {
      monthState.current = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 };
      renderCalendar(container, { dateField, readOnly, monthState, onPick });
    });
    if (!readOnly) {
      for (const btn of container.querySelectorAll(".cal-day.available")) {
        btn.addEventListener("click", () => onPick(byDate.get(btn.dataset.iso)));
      }
    }
  }

  function updateDateTriggers() {
    const option = state.route.options[state.optionIdx];
    $departTrigger.textContent = `📅 ${fmtDate(option.depart)}`;
    if (option.return) {
      $returnPicker.classList.remove("hidden");
      $returnTrigger.textContent = `📅 ${fmtDate(option.return)}`;
    } else {
      $returnPicker.classList.add("hidden");
    }
  }

  function selectOptionByDate(dateField, option) {
    const idx = state.route.options.indexOf(option);
    if (idx === -1) return;
    state.optionIdx = idx;
    closeAllCalendars();
    render();
  }

  function initDatePickers() {
    $departTrigger.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const opening = $departCal.classList.contains("hidden");
      closeAllCalendars();
      if (!opening) return;
      state.departCalMonth = {};
      renderCalendar($departCal, {
        dateField: "depart",
        readOnly: false,
        monthState: state.departCalMonth,
        onPick: (option) => selectOptionByDate("depart", option),
      });
      $departCal.classList.remove("hidden");
    });
    $returnTrigger.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const opening = $returnCal.classList.contains("hidden");
      closeAllCalendars();
      if (!opening) return;
      state.returnCalMonth = {};
      renderCalendar($returnCal, {
        dateField: "return",
        readOnly: false,
        monthState: state.returnCalMonth,
        onPick: (option) => selectOptionByDate("return", option),
      });
      $returnCal.classList.remove("hidden");
    });
  }

  // --- App -------------------------------------------------------------------

  async function init() {
    state.index = await (await fetch("data/index.json")).json();

    document.getElementById("updated-at").textContent =
      `Datos actualizados ${fmtAgo(state.index.generated_at)} · se actualizan automáticamente varias veces al día`;

    for (const route of state.index.routes) {
      const opt = document.createElement("option");
      opt.value = route.id;
      opt.textContent =
        route.tripType === "roundtrip"
          ? `${route.origin} → ${route.destination} · ${route.destination} → ${route.origin}`
          : `${route.origin} → ${route.destination}`;
      $route.appendChild(opt);
    }

    chartDefaults();
    initTheme();
    initCurrencyToggle();
    initDatePickers();
    $route.addEventListener("change", () => loadRoute($route.value));

    await loadRoute(state.index.routes[0].id);
  }

  async function loadRoute(id) {
    state.route = await (await fetch(`data/routes/${id}.json`)).json();

    // Preselect the cheapest date so the page opens on the best deal.
    let bestIdx = 0;
    state.route.options.forEach((option, i) => {
      if (option.best.price < state.route.options[bestIdx].best.price) bestIdx = i;
    });
    state.optionIdx = bestIdx;
    state.departCalMonth = null;
    state.returnCalMonth = null;
    closeAllCalendars();

    render();
  }

  function render() {
    const option = state.route.options[state.optionIdx];
    updateDateTriggers();
    renderSummary(option);
    renderTable(option);
    renderHistoryChart(option);
    renderDatesChart();
  }

  // Google Flights aggregates whichever airline is actually cheapest (often
  // LATAM, which we don't scrape directly) -- show that real airline instead
  // of the generic "Google Flights" bucket so it doesn't get lost.
  function siteLabel(site, airline) {
    if (site === "googleflights" && airline) return `${airline} (vía Google Flights)`;
    return SITE_LABELS[site] || site;
  }

  function renderSummary(option) {
    const el = document.getElementById("trip-summary");
    const best = option.best;
    const bestCur = option.current[best.site];
    el.classList.remove("hidden");
    el.innerHTML = `
      <div>
        <div class="big">${fmtDisplay(best.price, best.currency)}</div>
        <div class="sub">mejor precio en ${siteLabel(best.site, bestCur.airline)}
        ${bestCur.is_historical_min ? '<span class="badge-min">🏆 Mínimo histórico</span>' : ""}</div>
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
        <td><span class="site-cell"><span class="site-dot" style="background:${SITE_COLORS[site] || "#888"}"></span>${siteLabel(site, cur.airline)}</span>${
          cur.is_historical_min ? '<span class="badge-min">Mínimo histórico</span>' : ""
        }</td>
        <td class="num">${fmtDisplay(cur.price, cur.currency)}</td>
        <td class="muted">${fmtAgo(cur.scraped_at)}</td>
        <td>${cur.link ? `<a class="buy-btn" href="${cur.link}" target="_blank" rel="noopener">Ver y comprar</a>` : ""}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderHistoryChart(option) {
    const ctx = document.getElementById("history-chart");
    if (state.historyChart) state.historyChart.destroy();

    Chart.defaults.color = cssVar("--muted");
    Chart.defaults.borderColor = cssVar("--grid");

    // Union of scrape days across sites, as shared x labels.
    const days = [...new Set(Object.values(option.history).flatMap((h) => h.points.map((p) => p[0])))].sort();
    const displayCurrency = displayPrice(0, Object.values(option.history)[0]?.currency || "BRL").currency;
    const datasets = Object.entries(option.history).map(([site, h]) => {
      const byDay = new Map(h.points);
      return {
        label: SITE_LABELS[site] || site,
        data: days.map((d) => {
          const raw = byDay.get(d);
          return raw == null ? null : displayPrice(raw, h.currency).value;
        }),
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
              label: (item) => ` ${item.dataset.label}: ${fmtMoney(item.parsed.y, displayCurrency)}`,
            },
          },
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmtMoney(v, displayCurrency) },
          },
        },
      },
    });
  }

  function renderDatesChart() {
    const ctx = document.getElementById("dates-chart");
    if (state.datesChart) state.datesChart.destroy();

    Chart.defaults.color = cssVar("--muted");
    Chart.defaults.borderColor = cssVar("--grid");

    const options = state.route.options;
    const displayCurrency = displayPrice(0, options[0].best.currency).currency;
    const color = cssVar("--primary");

    state.datesChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: options.map((o) => fmtDate(o.depart)),
        datasets: [
          {
            label: "Mejor precio actual",
            data: options.map((o) => displayPrice(o.best.price, o.best.currency).value),
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
          state.departCalMonth = null;
          state.returnCalMonth = null;
          render();
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const o = options[item.dataIndex];
                const airline = o.current[o.best.site]?.airline;
                return ` ${fmtDisplay(o.best.price, o.best.currency)} (${siteLabel(o.best.site, airline)})`;
              },
            },
          },
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmtMoney(v, displayCurrency) },
          },
        },
      },
    });
  }

  init().catch((err) => {
    document.getElementById("updated-at").textContent = `Error cargando datos: ${err.message}`;
  });
})();
