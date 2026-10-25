/* -----------------------------------------------
   TradePulse - Analytics page
   Formulas live in analytics.js (tested). This file only displays
   them, with sample sizes, date ranges and the trades behind them.
----------------------------------------------- */
(function () {
  const root = document.querySelector('[data-page="analytics"]');
  if (!root) return;
  const { escapeHtml, plural, formatResultR, formatDate, formatRange, setStat } = TP;
  const A = window.TradeAnalytics;

  const el = (id) => document.getElementById(id);
  const detail = el("analyticsDetail");
  const empty = el("analyticsEmpty");
  const period = el("periodControl");

  const pct = (v) => (v === null ? "-" : `${Math.round(v * 100)}%`);
  const r = (v) => (v === null ? "-" : formatResultR(v).text);

  let trades = [];
  let field = "setup";
  let groups = [];
  let counted = [];

  function tradeTable(list, title) {
    const rows = A.sortByDate(list)
      .reverse()
      .slice(0, 200)
      .map((t) => {
        const res = formatResultR(t.result_r);
        return `<div class="trade-row"><span class="trade-secondary">${escapeHtml(t.entry_time || t.exit_time ? formatDate(t.entry_time || t.exit_time) : "No date")}</span><span class="trade-instrument">${escapeHtml(t.instrument)}</span><span class="trade-secondary">${escapeHtml(t.direction || "-")}</span><span class="trade-secondary">${escapeHtml(t.setup || t.session || "-")}</span><span class="trade-result ${res.cls}">${res.text}</span></div>`;
      })
      .join("");
    return `
      <div class="drilldown" id="drilldown" tabindex="-1">
        <div class="journal-list-header"><h2>${escapeHtml(title)}</h2><button class="link-button" type="button" data-drill-close>Close</button></div>
        <div class="trade-list"><div class="trade-list-head"><span>Date</span><span>Instrument</span><span>Direction</span><span>Setup</span><span style="text-align:end">Result</span></div>${rows}</div>
        ${list.length > 200 ? `<p class="card-copy">Showing the latest 200 of ${list.length}. All of them are in the Journal.</p>` : ""}
      </div>`;
  }

  function paint() {
    const s = A.summarise(trades);
    counted = trades.filter((t) => Number.isFinite(t.result_r));
    const range = formatRange(s.firstDate, s.lastDate);
    if (period) period.textContent = range ? `Trades from ${range}` : trades.length ? "Trades without dates" : "No data yet";

    if (!counted.length) {
      setStat(el("analyticsPerformanceStat"), el("analyticsPerformanceDetail"), "Awaiting data", trades.length ? `None of your ${plural(trades.length, "trade has", "trades have")} a result in R.` : "No verified trades.");
      setStat(el("analyticsRiskStat"), el("analyticsRiskDetail"), "Awaiting data", "No verified risk records.");
      setStat(el("analyticsBehaviourStat"), el("analyticsBehaviourDetail"), s.ruleAdherence === null ? "Awaiting data" : `${pct(s.ruleAdherence)} adherence`, s.ruleAdherence === null ? "No rule scores recorded." : `Based on ${plural(s.ruleScoredTrades, "trade", "trades")} with a rule score.`);
      if (empty) empty.hidden = false;
      if (detail) detail.innerHTML = "";
      return;
    }
    if (empty) empty.hidden = true;

    setStat(el("analyticsPerformanceStat"), el("analyticsPerformanceDetail"), `${r(s.netR)} net`, `${pct(s.winRate)} win rate, ${r(s.avgR)} average, across ${plural(s.countedTrades, "trade", "trades")}.`);
    setStat(el("analyticsRiskStat"), el("analyticsRiskDetail"), s.largestLoss === null ? "No losses" : `${r(s.largestLoss)} largest loss`, `Max drawdown ${r(s.maxDrawdownR === null ? null : -s.maxDrawdownR)}. ${s.losses ? `Average loss ${r(s.avgLoss)}.` : ""}`);
    setStat(el("analyticsBehaviourStat"), el("analyticsBehaviourDetail"), s.ruleAdherence === null ? "No rule scores" : `${pct(s.ruleAdherence)} adherence`, s.ruleAdherence === null ? "Add a rule score like 3/4 to trades to track this." : `Based on ${plural(s.ruleScoredTrades, "trade", "trades")} with a rule score.`);

    groups = A.breakdown(trades, field);
    const groupRows = groups
      .map(
        (g, i) => `
        <button class="breakdown-row" type="button" data-group="${i}">
          <span class="breakdown-key">${escapeHtml(g.key)}</span>
          <span>${g.count}</span>
          <span>${pct(g.winRate)}</span>
          <span class="${g.netR > 0 ? "positive" : g.netR < 0 ? "negative" : ""}">${r(g.netR)}</span>
          <span>${r(g.avgR)}</span>
          <span class="breakdown-flag">${g.tooFew ? "Too few to compare" : ""}</span>
        </button>`,
      )
      .join("");

    detail.innerHTML = `
      <section class="surface card-pad">
        <div class="analytics-sample ${s.smallSample ? "is-small" : ""}">
          <p class="card-copy"><strong>Based on ${plural(s.countedTrades, "trade", "trades")} with a result in R${range ? `, ${escapeHtml(range)}` : ""}.</strong>
          ${s.withoutResult ? ` ${plural(s.withoutResult, "trade has", "trades have")} no R result and ${s.withoutResult === 1 ? "is" : "are"} not counted.` : ""}
          ${s.undatedTrades ? ` ${plural(s.undatedTrades, "trade has", "trades have")} no date.` : ""}</p>
          ${s.smallSample ? `<p class="card-copy">This is a small sample (under ${A.SMALL_SAMPLE} trades). Treat these numbers as a starting point, not a pattern.</p>` : ""}
          <button class="link-button" type="button" data-drill-all>See the ${plural(s.countedTrades, "trade", "trades")} counted</button>
        </div>

        <dl class="metric-list">
          <div><dt>Wins / losses / breakeven</dt><dd>${s.wins} / ${s.losses} / ${s.breakeven}</dd></div>
          <div><dt>Win rate</dt><dd>${pct(s.winRate)}</dd></div>
          <div><dt>Net R</dt><dd>${r(s.netR)}</dd></div>
          <div><dt>Average R per trade</dt><dd>${r(s.avgR)}</dd></div>
          <div><dt>Average win</dt><dd>${r(s.avgWin)}</dd></div>
          <div><dt>Average loss</dt><dd>${r(s.avgLoss)}</dd></div>
          <div><dt>Profit factor</dt><dd>${s.profitFactor === null ? "-" : s.profitFactor.toFixed(2)}</dd></div>
          <div><dt>Max drawdown</dt><dd>${r(s.maxDrawdownR === null ? null : -s.maxDrawdownR)}</dd></div>
        </dl>
      </section>

      <section class="surface card-pad">
        <div class="journal-list-header">
          <h2 class="card-title">Breakdown</h2>
          <label class="breakdown-select">By
            <select id="breakdownField">
              ${["setup", "session", "instrument", "direction"].map((f) => `<option value="${f}"${f === field ? " selected" : ""}>${f[0].toUpperCase() + f.slice(1)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="breakdown">
          <div class="breakdown-row breakdown-head"><span>${field[0].toUpperCase() + field.slice(1)}</span><span>Trades</span><span>Win rate</span><span>Net R</span><span>Avg R</span><span></span></div>
          ${groupRows}
        </div>
        <p class="card-copy">Groups with fewer than ${A.MIN_GROUP} trades are marked. Click a row to see its trades.</p>
      </section>

      <div id="drillSlot"></div>

      <details class="surface card-pad definitions">
        <summary>How these numbers are calculated</summary>
        <ul>
          <li><strong>Counted trades</strong> have a numeric result in R. Trades without R are listed in the Journal but left out here.</li>
          <li><strong>Win</strong> is above 0R, <strong>loss</strong> is below 0R, <strong>breakeven</strong> is exactly 0R.</li>
          <li><strong>Win rate</strong> is wins divided by wins plus losses. Breakeven trades are left out of it.</li>
          <li><strong>Average R</strong> is net R divided by counted trades.</li>
          <li><strong>Profit factor</strong> is total R from wins divided by total R lost. It only shows when there's at least one loss.</li>
          <li><strong>Max drawdown</strong> is the largest fall in cumulative R from a previous high, with trades in date order (entry time, then exit time, then the date added).</li>
          <li><strong>Rule adherence</strong> is rules followed divided by rules possible, from rule scores written like 3/4.</li>
          <li>Everything is calculated in your browser from the trades in your journal. No AI is used.</li>
        </ul>
      </details>`;

    detail.querySelector("#breakdownField").addEventListener("change", (e) => {
      field = e.target.value;
      paint();
    });
  }

  detail?.addEventListener("click", (e) => {
    const slot = detail.querySelector("#drillSlot");
    if (!slot) return;
    const g = e.target.closest("[data-group]");
    if (g) {
      const grp = groups[Number(g.dataset.group)];
      slot.innerHTML = tradeTable(grp.trades, `${field[0].toUpperCase() + field.slice(1)}: ${grp.key} (${plural(grp.count, "trade", "trades")})`);
      return slot.querySelector("#drilldown").focus();
    }
    if (e.target.closest("[data-drill-all]")) {
      slot.innerHTML = tradeTable(counted, `All counted trades (${counted.length})`);
      return slot.querySelector("#drilldown").focus();
    }
    if (e.target.closest("[data-drill-close]")) slot.innerHTML = "";
  });

  async function render() {
    for (const [a, b] of [["analyticsPerformanceStat", "analyticsPerformanceDetail"], ["analyticsRiskStat", "analyticsRiskDetail"], ["analyticsBehaviourStat", "analyticsBehaviourDetail"]]) {
      setStat(el(a), el(b), "Loading", "Checking your trades.");
    }
    try {
      trades = await TP.getTrades();
    } catch (err) {
      for (const [a, b] of [["analyticsPerformanceStat", "analyticsPerformanceDetail"], ["analyticsRiskStat", "analyticsRiskDetail"], ["analyticsBehaviourStat", "analyticsBehaviourDetail"]]) {
        setStat(el(a), el(b), "Couldn't load", "Refresh the page to try again.");
      }
      if (empty) empty.hidden = true;
      TP.regionError(detail, "Your trades couldn't be loaded.", "trades");
      return;
    }
    paint();
  }

  TP.ready.then(render);
  document.addEventListener("tp:data-changed", (e) => {
    if (!e.detail.kind || e.detail.kind === "trades") render();
  });
})();
