(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LWC = window.LightweightCharts;

  const UP = "#089981";
  const DOWN = "#f23645";
  const REFRESH_MS = 30000;

  const state = {
    symbol: "AAPL",
    range: "1d",
    type: "candles",
    volume: true,
    sma20: false,
    sma50: false,
    log: false,
    data: null,
  };

  // ---------- persisted prefs & URL hash ----------
  try {
    const saved = JSON.parse(localStorage.getItem("stockchart.prefs") || "{}");
    Object.assign(state, pick(saved, ["range", "type", "volume", "sma20", "sma50", "log", "symbol"]));
  } catch (_) { /* storage unavailable */ }
  readHash();

  function pick(obj, keys) {
    const out = {};
    keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }
  function savePrefs() {
    try {
      localStorage.setItem("stockchart.prefs", JSON.stringify(
        pick(state, ["range", "type", "volume", "sma20", "sma50", "log", "symbol"])));
    } catch (_) { /* ignore */ }
    const hash = `#${encodeURIComponent(state.symbol)}/${state.range}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  function readHash() {
    const m = location.hash.match(/^#([^/]+)(?:\/(\w+))?/);
    if (!m) return;
    state.symbol = decodeURIComponent(m[1]).toUpperCase();
    if (m[2]) state.range = m[2].toLowerCase();
  }

  // ---------- theme ----------
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = (() => { try { return localStorage.getItem("stockchart.theme"); } catch (_) { return null; } })()
    || (prefersDark.matches ? "dark" : "light");

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue("--bg").trim(),
      text: cs.getPropertyValue("--text").trim(),
      muted: cs.getPropertyValue("--muted").trim(),
      border: cs.getPropertyValue("--border").trim(),
    };
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#171d24" : "#f5f7fa";
    if (!chart) return;
    const c = themeColors();
    chart.applyOptions({
      layout: { background: { color: c.bg }, textColor: c.text },
      grid: {
        vertLines: { color: theme === "dark" ? "#1e252e" : "#f0f3fa" },
        horzLines: { color: theme === "dark" ? "#1e252e" : "#f0f3fa" },
      },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
  }
  $("themeBtn").addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("stockchart.theme", theme); } catch (_) { /* ignore */ }
    applyTheme();
    if (state.data) renderSeries(false);
  });
  document.documentElement.dataset.theme = theme;

  // ---------- chart ----------
  const chartEl = $("chart");
  const chart = LWC.createChart(chartEl, {
    autoSize: true,
    layout: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.25 } },
    timeScale: { rightOffset: 4, minBarSpacing: 0.5 },
    handleScroll: { vertTouchDrag: false }, // let the page scroll vertically on phones
    localization: { priceFormatter: (p) => fmtPrice(p) },
  });
  applyTheme();

  let mainSeries = null;
  let volumeSeries = null;
  let sma20Series = null;
  let sma50Series = null;
  let prevCloseLine = null;

  function clearSeries() {
    [mainSeries, volumeSeries, sma20Series, sma50Series].forEach((s) => s && chart.removeSeries(s));
    mainSeries = volumeSeries = sma20Series = sma50Series = prevCloseLine = null;
  }

  function createMainSeries() {
    const common = { priceLineVisible: true, lastValueVisible: true };
    switch (state.type) {
      case "line":
        return chart.addLineSeries({ ...common, color: "#2962ff", lineWidth: 2 });
      case "area": {
        const up = isUpOverall();
        const col = up ? UP : DOWN;
        return chart.addAreaSeries({
          ...common, lineColor: col, lineWidth: 2,
          topColor: hexA(col, 0.35), bottomColor: hexA(col, 0.02),
        });
      }
      case "bars":
        return chart.addBarSeries({ ...common, upColor: UP, downColor: DOWN, thinBars: false });
      default:
        return chart.addCandlestickSeries({
          ...common, upColor: UP, downColor: DOWN, borderVisible: false,
          wickUpColor: UP, wickDownColor: DOWN,
        });
    }
  }

  function renderSeries(fit = true) {
    const d = state.data;
    if (!d) return;
    const range = fit ? null : chart.timeScale().getVisibleLogicalRange();
    clearSeries();

    const candles = shiftedCandles();
    mainSeries = createMainSeries();
    const isOhlc = state.type === "candles" || state.type === "bars";
    mainSeries.setData(isOhlc ? candles : candles.map((c) => ({ time: c.time, value: c.close })));

    if (d.previousClose && state.range === "1d") {
      prevCloseLine = mainSeries.createPriceLine({
        price: d.previousClose, color: themeColors().muted, lineWidth: 1,
        lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: "Prev close",
      });
    }

    if (state.volume) {
      volumeSeries = chart.addHistogramSeries({
        priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volumeSeries.setData(candles.map((c) => ({
        time: c.time, value: c.volume, color: hexA(c.close >= c.open ? UP : DOWN, 0.45),
      })));
    }
    if (state.sma20) sma20Series = addSma(candles, 20, "#ff9800");
    if (state.sma50) sma50Series = addSma(candles, 50, "#ab47bc");

    chart.priceScale("right").applyOptions({
      mode: state.log ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal,
      scaleMargins: { top: 0.12, bottom: state.volume ? 0.25 : 0.08 },
    });
    chart.applyOptions({
      timeScale: { timeVisible: d.intraday, secondsVisible: false },
    });

    if (fit || !range) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange(range);
    updateLegend(null);
  }

  function addSma(candles, period, color) {
    const s = chart.addLineSeries({
      color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    const out = [];
    let sum = 0;
    candles.forEach((c, i) => {
      sum += c.close;
      if (i >= period) sum -= candles[i - period].close;
      if (i >= period - 1) out.push({ time: c.time, value: sum / period });
    });
    s.setData(out);
    return s;
  }

  // Lightweight Charts renders timestamps as UTC, so shift into the exchange's local time.
  function shiftedCandles() {
    const off = state.data.gmtoffset || 0;
    const seen = new Set();
    return state.data.candles
      .map((c) => ({ ...c, time: c.time + off }))
      .filter((c) => (seen.has(c.time) ? false : seen.add(c.time)));
  }

  function isUpOverall() {
    const d = state.data;
    if (!d || !d.candles.length) return true;
    const base = state.range === "1d" && d.previousClose ? d.previousClose : d.candles[0].open;
    return d.candles[d.candles.length - 1].close >= base;
  }

  // ---------- legend (crosshair) ----------
  const legendEl = $("legend");
  chart.subscribeCrosshairMove((param) => updateLegend(param));

  function updateLegend(param) {
    const d = state.data;
    if (!d || !mainSeries) { legendEl.innerHTML = ""; return; }
    let bar = param && param.time !== undefined ? param.seriesData.get(mainSeries) : null;
    let time = param && param.time;
    let candle;
    const candles = shiftedCandles();
    if (!bar) {
      candle = candles[candles.length - 1];
      time = candle && candle.time;
    } else {
      candle = candles.find((c) => c.time === time);
    }
    if (!candle) { legendEl.innerHTML = ""; return; }
    const chg = candle.close - candle.open;
    const cls = chg >= 0 ? "up" : "down";
    const parts = [
      `<span><b>${esc(d.symbol)}</b> <span class="lbl">${fmtTime(time, d.intraday)}</span></span>`,
      `<span><span class="lbl">O</span> ${fmtPrice(candle.open)}</span>`,
      `<span><span class="lbl">H</span> ${fmtPrice(candle.high)}</span>`,
      `<span><span class="lbl">L</span> ${fmtPrice(candle.low)}</span>`,
      `<span><span class="lbl">C</span> <span class="chg ${cls}">${fmtPrice(candle.close)}</span></span>`,
      `<span class="chg ${cls}">${chg >= 0 ? "+" : ""}${fmtPrice(chg)} (${pct(chg, candle.open)})</span>`,
      `<span><span class="lbl">Vol</span> ${fmtVol(candle.volume)}</span>`,
    ];
    if (param && param.seriesData) {
      const s20 = sma20Series && param.seriesData.get(sma20Series);
      const s50 = sma50Series && param.seriesData.get(sma50Series);
      if (s20) parts.push(`<span style="color:#ff9800">MA20 ${fmtPrice(s20.value)}</span>`);
      if (s50) parts.push(`<span style="color:#ab47bc">MA50 ${fmtPrice(s50.value)}</span>`);
    }
    legendEl.innerHTML = parts.join("");
  }

  // ---------- quote header ----------
  const RANGE_LABEL = {
    "1d": "today", "5d": "past 5 days", "1w": "past week", "1m": "past month", "6m": "past 6 months",
    ytd: "year to date", "1y": "past year", "5y": "past 5 years", max: "all time",
  };

  function renderQuote() {
    const d = state.data;
    document.title = `${d.symbol} ${fmtPrice(d.price)} · StockChart`;
    $("qSymbol").textContent = d.symbol;
    $("qName").textContent = d.name || "";
    $("qPrice").textContent = `${fmtPrice(d.price)} ${d.currency || ""}`;

    const first = d.candles[0];
    const base = state.range === "1d" && d.previousClose ? d.previousClose : first && first.open;
    const chg = base ? d.price - base : 0;
    const el = $("qChange");
    el.textContent = base ? `${chg >= 0 ? "+" : ""}${fmtPrice(chg)} (${pct(chg, base)})` : "";
    el.className = `chg ${chg >= 0 ? "up" : "down"}`;
    $("qRangeLabel").textContent = RANGE_LABEL[state.range] || "";

    const meta = [
      ["Exchange", d.exchange],
      ["Day range", d.dayLow && d.dayHigh ? `${fmtPrice(d.dayLow)} – ${fmtPrice(d.dayHigh)}` : null],
      ["52W range", d.low52 && d.high52 ? `${fmtPrice(d.low52)} – ${fmtPrice(d.high52)}` : null],
      ["Volume", d.volume ? fmtVol(d.volume) : null],
      ["Prev close", d.previousClose ? fmtPrice(d.previousClose) : null],
      ["Updated", d.marketTime ? new Date(d.marketTime * 1000).toLocaleString() : null],
    ].filter(([, v]) => v);
    $("qMeta").innerHTML = meta.map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join("");
  }

  // ---------- data loading ----------
  let loadSeq = 0;
  let refreshTimer = null;

  async function load({ silent = false } = {}) {
    const seq = ++loadSeq;
    const symbol = state.symbol;
    if (!silent) showStatus('<div class="spinner"></div>Loading ' + esc(symbol) + "…");
    try {
      const res = await fetch(`/api/chart/${encodeURIComponent(symbol)}?range=${state.range}`);
      const body = await res.json();
      if (seq !== loadSeq) return; // a newer request superseded this one
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (!body.candles.length) throw new Error(`No data for ${symbol} in this range`);
      const isRefresh = silent && state.data && state.data.symbol === body.symbol;
      state.data = body;
      renderQuote();
      renderSeries(!isRefresh);
      hideStatus();
      savePrefs();
    } catch (e) {
      if (seq !== loadSeq) return;
      if (!silent) showStatus(esc(e.message || "Failed to load data"), true);
    } finally {
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (document.visibilityState === "visible") load({ silent: true });
      else scheduleRefresh();
    }, REFRESH_MS);
  }

  function showStatus(html, isError = false) {
    const el = $("status");
    el.innerHTML = html;
    el.className = `status${isError ? " error" : ""}`;
    el.hidden = false;
  }
  function hideStatus() { $("status").hidden = true; }

  // ---------- toolbar ----------
  function syncButtons() {
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("active", b.dataset.range === state.range));
    document.querySelectorAll("#types button").forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
    $("optVolume").checked = state.volume;
    $("optSma20").checked = state.sma20;
    $("optSma50").checked = state.sma50;
    $("optLog").checked = state.log;
  }

  $("ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.range === state.range) return;
    state.range = b.dataset.range;
    syncButtons();
    load();
  });
  $("types").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.type = b.dataset.type;
    syncButtons();
    savePrefs();
    renderSeries(false);
  });
  [["optVolume", "volume"], ["optSma20", "sma20"], ["optSma50", "sma50"], ["optLog", "log"]].forEach(([id, key]) => {
    $(id).addEventListener("change", (e) => {
      state[key] = e.target.checked;
      savePrefs();
      renderSeries(false);
    });
  });
  $("fitBtn").addEventListener("click", () => chart.timeScale().fitContent());
  $("fullBtn").addEventListener("click", () => {
    const wrap = $("chartWrap");
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
  });
  if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) $("fullBtn").hidden = true;

  window.addEventListener("hashchange", () => {
    const prev = `${state.symbol}/${state.range}`;
    readHash();
    if (`${state.symbol}/${state.range}` !== prev) { syncButtons(); load(); }
  });

  // ---------- measure tool (Shift + drag) ----------
  (() => {
    const wrap = $("chartWrap");
    let start = null;
    let box = null;
    let label = null;

    wrap.addEventListener("mousedown", (e) => {
      if (!e.shiftKey || !mainSeries || e.button !== 0) return;
      const pt = localPoint(e);
      const price = mainSeries.coordinateToPrice(pt.y);
      if (price === null) return;
      e.preventDefault();
      chart.applyOptions({ handleScroll: false, handleScale: false });
      start = { ...pt, price, logical: chart.timeScale().coordinateToLogical(pt.x) };
      box = document.createElement("div");
      box.className = "measure";
      label = document.createElement("div");
      label.className = "measure-label";
      wrap.append(box, label);
    });
    window.addEventListener("mousemove", (e) => {
      if (!start) return;
      const pt = localPoint(e);
      const price = mainSeries.coordinateToPrice(pt.y);
      if (price === null) return;
      const bars = Math.round(chart.timeScale().coordinateToLogical(pt.x) - start.logical);
      const diff = price - start.price;
      Object.assign(box.style, {
        left: `${Math.min(start.x, pt.x)}px`, top: `${Math.min(start.y, pt.y)}px`,
        width: `${Math.abs(pt.x - start.x)}px`, height: `${Math.abs(pt.y - start.y)}px`,
      });
      label.textContent = `${diff >= 0 ? "+" : ""}${fmtPrice(diff)} (${pct(diff, start.price)}) · ${Math.abs(bars)} bars`;
      label.style.background = diff >= 0 ? UP : DOWN;
      label.style.left = `${Math.min(pt.x + 12, wrap.clientWidth - 200)}px`;
      label.style.top = `${Math.max(pt.y - 30, 4)}px`;
    });
    window.addEventListener("mouseup", () => {
      if (!start) return;
      start = null;
      chart.applyOptions({ handleScroll: { vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true }, handleScale: true });
      setTimeout(() => { box && box.remove(); label && label.remove(); }, 1500);
    });
    function localPoint(e) {
      const r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
  })();

  // ---------- autocomplete ----------
  (() => {
    const input = $("search");
    const list = $("suggestions");
    let items = [];
    let active = -1;
    let timer = null;
    let reqSeq = 0;
    const cache = new Map();

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { close(); return; }
      timer = setTimeout(() => search(q), 200);
    });

    async function search(q) {
      const seq = ++reqSeq;
      let results = cache.get(q.toLowerCase());
      if (!results) {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          results = res.ok ? await res.json() : [];
          cache.set(q.toLowerCase(), results);
        } catch (_) {
          results = [];
        }
      }
      if (seq !== reqSeq || input.value.trim() !== q) return;
      items = results;
      active = items.length ? 0 : -1;
      render(q);
    }

    function render(q) {
      if (!items.length) {
        list.innerHTML = `<li class="empty">No matches for “${esc(q)}”. Press Enter to try “${esc(q.toUpperCase())}”.</li>`;
      } else {
        list.innerHTML = items.map((it, i) => `
          <li role="option" id="opt${i}" data-i="${i}" aria-selected="${i === active}">
            <span class="sym">${highlight(it.symbol, q)}</span>
            <span class="nm">${highlight(it.name || "", q)}</span>
            <span class="ex">${esc([it.type, it.exchange].filter(Boolean).join(" · "))}</span>
          </li>`).join("");
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (active >= 0) input.setAttribute("aria-activedescendant", `opt${active}`);
    }

    function setActive(i) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      list.querySelectorAll("li[role=option]").forEach((li, idx) => li.setAttribute("aria-selected", idx === active));
      const li = $(`opt${active}`);
      if (li) li.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", `opt${active}`);
    }

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      items = [];
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function choose(symbol) {
      if (!symbol) return;
      close();
      input.value = "";
      input.blur(); // hide mobile keyboard
      state.symbol = symbol.toUpperCase();
      load();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (active >= 0 && items[active]) choose(items[active].symbol);
        else if (input.value.trim()) choose(input.value.trim());
      }
    });
    // pointerdown fires before blur, so the tap registers on mobile
    list.addEventListener("pointerdown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      e.preventDefault();
      choose(items[+li.dataset.i].symbol);
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    });

    function highlight(text, q) {
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return esc(text);
      return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
    }
  })();

  // ---------- formatting ----------
  function fmtPrice(p) {
    if (p === null || p === undefined || isNaN(p)) return "—";
    const abs = Math.abs(p);
    const digits = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
    return p.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtVol(v) {
    if (!v) return "0";
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [n, u] of units) if (v >= n) return (v / n).toFixed(2).replace(/\.?0+$/, "") + u;
    return String(v);
  }
  function pct(diff, base) {
    if (!base) return "—";
    const v = (diff / base) * 100;
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  }
  // time is already shifted to exchange-local, so format it as UTC
  function fmtTime(t, intraday) {
    const d = new Date(t * 1000);
    const opts = intraday
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
      : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    return d.toLocaleString(undefined, opts);
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- boot ----------
  syncButtons();
  load();
})();
