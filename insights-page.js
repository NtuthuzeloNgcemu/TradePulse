/* -----------------------------------------------
   TradePulse - Insights page
   Calculated observations from the user's own trades (analytics.js).
   Each one shows its evidence, sample size, dates and limitation.
   No AI is involved, and nothing appears without enough evidence.
----------------------------------------------- */
(function () {
  const root = document.getElementById("insightsContent");
  if (!root) return;
  const { escapeHtml, plural, formatResultR, formatDate, formatRange } = TP;
  const A = window.TradeAnalytics;
  const HIDDEN_KEY = "tp_hidden_insights";

  const getHidden = () => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem(HIDDEN_KEY) || "[]"));
    } catch (err) {
      return new Set();
    }
  };
  const setHidden = (set) => {
    try {
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
    } catch (err) {
      /* per-device convenience only */
    }
  };

  let observations = [];
  let showHidden = false;

  function evidenceList(list) {
    return A.sortByDate(list)
      .reverse()
      .slice(0, 50)
      .map((t) => {
        const r = formatResultR(t.result_r);
        return `<div class="trade-row"><span class="trade-secondary">${escapeHtml(t.entry_time || t.exit_time ? formatDate(t.entry_time || t.exit_time) : "No date")}</span><span class="trade-instrument">${escapeHtml(t.instrument)}</span><span class="trade-secondary">${escapeHtml(t.setup || "-")}</span><span class="trade-secondary">${escapeHtml(t.session || "-")}</span><span class="trade-result ${r.cls}">${r.text}</span></div>`;
      })
      .join("");
  }

  function paint(trades) {
    const s = A.summarise(trades);
    if (s.countedTrades < A.SMALL_SAMPLE) {
      root.innerHTML = `
        <section class="surface empty">
          <h2>There are no personalised insights to show.</h2>
          <p>Insights need at least ${A.SMALL_SAMPLE} trades with a result in R. You have ${s.countedTrades}${s.withoutResult ? `, plus ${plural(s.withoutResult, "trade", "trades")} without R` : ""}. Add more trades and TradePulse will compare them for you.</p>
          <button class="add-button" type="button" data-open-upload>Add trades</button>
          <p class="subtle">No generic trading advice is shown as a personal insight.</p>
        </section>`;
      return;
    }

    observations = A.observations(trades);
    const hidden = getHidden();
    const visible = observations.filter((o) => showHidden || !hidden.has(o.id));
    const hiddenCount = observations.filter((o) => hidden.has(o.id)).length;

    if (!observations.length) {
      root.innerHTML = `
        <section class="surface empty">
          <h2>Nothing stands out in your trades yet.</h2>
          <p>TradePulse compared your ${plural(s.countedTrades, "trade", "trades")} by setup, session, instrument, direction and rule score. No group of ${A.MIN_GROUP} or more trades differed from the rest by ${A.MIN_DIFF_R}R or more on average.</p>
        </section>`;
      return;
    }

    root.innerHTML = `
      <p class="card-copy insights-intro">Calculated from your ${plural(s.countedTrades, "trade", "trades")} with a result in R${formatRange(s.firstDate, s.lastDate) ? `, ${escapeHtml(formatRange(s.firstDate, s.lastDate))}` : ""}. No AI was used. Each observation compares averages, so it shows what happened, not why.</p>
      ${visible
        .map(
          (o) => `
        <article class="surface card-pad insight-card" data-insight="${escapeHtml(o.id)}">
          <h2 class="card-title">${escapeHtml(o.claim)}</h2>
          <p class="card-copy">Win rate ${o.groupWinRate === null ? "-" : `${Math.round(o.groupWinRate * 100)}%`} compared with ${o.restWinRate === null ? "-" : `${Math.round(o.restWinRate * 100)}%`}.${o.firstDate ? ` Trades from ${escapeHtml(formatRange(o.firstDate, o.lastDate))}.` : ""}</p>
          <p class="card-copy insight-limit">${escapeHtml(o.limitation)}</p>
          <div class="insight-actions">
            <button class="link-button" type="button" data-evidence="${escapeHtml(o.id)}" aria-expanded="false">Show the ${plural(o.groupCount, "trade", "trades")}</button>
            <button class="link-button" type="button" data-hide="${escapeHtml(o.id)}">${hidden.has(o.id) ? "Show again" : "Hide"}</button>
          </div>
          <div class="insight-evidence" hidden></div>
        </article>`,
        )
        .join("")}
      ${hiddenCount ? `<button class="link-button" type="button" data-toggle-hidden>${showHidden ? "Don't show hidden observations" : `Show ${plural(hiddenCount, "hidden observation", "hidden observations")}`}</button>` : ""}`;
  }

  root.addEventListener("click", (e) => {
    const ev = e.target.closest("[data-evidence]");
    if (ev) {
      const card = ev.closest(".insight-card");
      const box = card.querySelector(".insight-evidence");
      const o = observations.find((x) => x.id === ev.dataset.evidence);
      const open = box.hidden;
      box.hidden = !open;
      ev.setAttribute("aria-expanded", String(open));
      if (open) {
        box.innerHTML = `<div class="trade-list"><div class="trade-list-head"><span>Date</span><span>Instrument</span><span>Setup</span><span>Session</span><span style="text-align:end">Result</span></div>${evidenceList(o.evidence)}</div>${o.evidence.length > 50 ? `<p class="card-copy">Showing the latest 50 of ${o.evidence.length}.</p>` : ""}`;
      }
      return;
    }
    const hide = e.target.closest("[data-hide]");
    if (hide) {
      const set = getHidden();
      set.has(hide.dataset.hide) ? set.delete(hide.dataset.hide) : set.add(hide.dataset.hide);
      setHidden(set);
      return render();
    }
    if (e.target.closest("[data-toggle-hidden]")) {
      showHidden = !showHidden;
      render();
    }
  });

  async function render() {
    TP.regionLoading(root, "Checking your trades.");
    try {
      paint(await TP.getTrades());
    } catch (err) {
      TP.regionError(root, "Your trades couldn't be loaded.", "trades");
    }
    root.removeAttribute("aria-busy");
  }

  TP.ready.then(render);
  document.addEventListener("tp:data-changed", (e) => {
    if (!e.detail.kind || e.detail.kind === "trades") render();
  });
})();
