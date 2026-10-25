/* -----------------------------------------------
   TradePulse - analytics and calculated observations
   Pure functions, tested in tests/analytics.test.js.

   DEFINITIONS (shown to users on the Analytics page)
   - Counted trade: a trade with a numeric Result (R). Trades without
     an R result are listed but excluded from R metrics.
   - Win: R > 0. Loss: R < 0. Breakeven: R = 0.
   - Win rate: wins / (wins + losses). Breakeven trades are excluded
     from the win rate and reported separately.
   - Net R: sum of R. Average R (expectancy): net R / counted trades.
   - Average win / average loss: mean R of wins / of losses.
   - Profit factor: total R of wins / absolute total R of losses
     (only when there is at least one loss).
   - Largest loss: the most negative R.
   - Max drawdown (R): largest fall from a running peak of cumulative
     R, with trades ordered by trade date (entry time, then exit time,
     then the date the trade was added).
   - Rule adherence: rules followed / rules possible, across trades
     with a rule score written as "x/y" where 0 <= x <= y and y > 0.
   - Small sample: fewer than 20 counted trades.
----------------------------------------------- */

(function (root) {
  "use strict";

  const SMALL_SAMPLE = 20;
  const MIN_GROUP = 10; // smallest group used in a comparison
  const MIN_DIFF_R = 0.5; // smallest difference in average R worth reporting

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const round = (v, dp = 2) => (isNum(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

  function tradeDate(t) {
    return t.entry_time || t.exit_time || t.created_at || null;
  }

  function parseRuleScore(score) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(score || "").trim());
    if (!m) return null;
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total <= 0 || done > total) return null;
    return { done, total };
  }

  function normaliseTrades(trades) {
    return (trades || []).map((t) => ({ ...t, result_r: toNum(t.result_r) }));
  }

  function sortByDate(trades) {
    return [...trades].sort((a, b) => {
      const da = tradeDate(a);
      const db = tradeDate(b);
      if (da === db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    });
  }

  function summarise(tradesIn) {
    const trades = normaliseTrades(tradesIn);
    const counted = trades.filter((t) => isNum(t.result_r));
    const wins = counted.filter((t) => t.result_r > 0);
    const losses = counted.filter((t) => t.result_r < 0);
    const breakeven = counted.filter((t) => t.result_r === 0);
    const sum = (arr) => arr.reduce((s, t) => s + t.result_r, 0);

    const netR = sum(counted);
    const decided = wins.length + losses.length;
    const lossTotal = Math.abs(sum(losses));

    // Max drawdown over date-ordered cumulative R
    let peak = 0;
    let cum = 0;
    let maxDd = 0;
    for (const t of sortByDate(counted)) {
      cum += t.result_r;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
    }

    const scores = trades.map((t) => parseRuleScore(t.rule_score)).filter(Boolean);
    const rulesDone = scores.reduce((s, x) => s + x.done, 0);
    const rulesTotal = scores.reduce((s, x) => s + x.total, 0);

    const dated = trades.map((t) => t.entry_time || t.exit_time).filter(Boolean).sort();

    return {
      totalTrades: trades.length,
      countedTrades: counted.length,
      withoutResult: trades.length - counted.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      winRate: decided ? wins.length / decided : null,
      netR: counted.length ? round(netR, 4) : null,
      avgR: counted.length ? round(netR / counted.length, 4) : null,
      avgWin: wins.length ? round(sum(wins) / wins.length, 4) : null,
      avgLoss: losses.length ? round(sum(losses) / losses.length, 4) : null,
      profitFactor: losses.length ? round(sum(wins) / lossTotal, 4) : null,
      largestLoss: losses.length ? Math.min(...losses.map((t) => t.result_r)) : null,
      maxDrawdownR: counted.length ? round(maxDd, 4) : null,
      ruleAdherence: rulesTotal ? rulesDone / rulesTotal : null,
      ruleScoredTrades: scores.length,
      firstDate: dated[0] || null,
      lastDate: dated[dated.length - 1] || null,
      undatedTrades: trades.length - dated.length,
      smallSample: counted.length < SMALL_SAMPLE,
    };
  }

  const GROUP_FIELDS = {
    setup: "Setup",
    session: "Session",
    instrument: "Instrument",
    direction: "Direction",
  };

  function groupKey(t, field) {
    const v = t[field];
    if (v === null || v === undefined || String(v).trim() === "") return null;
    return field === "instrument" ? String(v).trim().toUpperCase() : String(v).trim();
  }

  /** Breakdown of counted trades by one field. Trades without a value are grouped as "Not recorded". */
  function breakdown(tradesIn, field) {
    const counted = normaliseTrades(tradesIn).filter((t) => isNum(t.result_r));
    const groups = new Map();
    for (const t of counted) {
      const key = groupKey(t, field) ?? "Not recorded";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    return [...groups.entries()]
      .map(([key, list]) => {
        const s = summarise(list);
        return { key, trades: list, count: list.length, winRate: s.winRate, netR: s.netR, avgR: s.avgR, tooFew: list.length < MIN_GROUP };
      })
      // Largest groups first; "Not recorded" always last
      .sort((a, b) => (a.key === "Not recorded") - (b.key === "Not recorded") || b.count - a.count || String(a.key).localeCompare(String(b.key)));
  }

  /**
   * Calculated observations. Only produced when:
   *  - there are at least SMALL_SAMPLE counted trades overall,
   *  - the group and the rest each have at least MIN_GROUP trades,
   *  - the difference in average R is at least MIN_DIFF_R.
   * They describe a difference in averages. They don't explain why.
   */
  function observations(tradesIn) {
    const all = normaliseTrades(tradesIn).filter((t) => isNum(t.result_r));
    const out = [];
    if (all.length < SMALL_SAMPLE) return out;

    const compare = (id, label, inGroup, rest, describe) => {
      if (inGroup.length < MIN_GROUP || rest.length < MIN_GROUP) return;
      const a = summarise(inGroup);
      const b = summarise(rest);
      const diff = a.avgR - b.avgR;
      if (Math.abs(diff) < MIN_DIFF_R) return;
      const dates = [...inGroup, ...rest].map((t) => t.entry_time || t.exit_time).filter(Boolean).sort();
      out.push({
        id,
        type: "Observation",
        label,
        direction: diff > 0 ? "better" : "worse",
        claim: describe(a, b, diff),
        groupCount: inGroup.length,
        restCount: rest.length,
        groupAvgR: a.avgR,
        restAvgR: b.avgR,
        groupWinRate: a.winRate,
        restWinRate: b.winRate,
        evidence: inGroup,
        comparison: rest,
        firstDate: dates[0] || null,
        lastDate: dates[dates.length - 1] || null,
        limitation:
          "This compares averages from your own records. It doesn't show why the difference exists, and it can change as you add trades.",
      });
    };

    const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}R`;

    for (const field of ["setup", "session", "instrument", "direction"]) {
      const recorded = breakdown(all, field).filter((g) => g.key !== "Not recorded");
      // With exactly two groups, "A vs the rest" and "B vs the rest" are the
      // same comparison, so only the larger group is reported.
      for (const g of recorded.length === 2 ? recorded.slice(0, 1) : recorded) {
        const rest = all.filter((t) => (groupKey(t, field) ?? "Not recorded") !== g.key && groupKey(t, field) !== null);
        compare(
          `${field}:${g.key}`,
          `${GROUP_FIELDS[field]}: ${g.key}`,
          g.trades,
          rest,
          (a, b) =>
            `Trades with ${GROUP_FIELDS[field].toLowerCase()} "${g.key}" averaged ${fmt(a.avgR)} over ${a.countedTrades} trades, compared with ${fmt(b.avgR)} over ${b.countedTrades} other trades where ${GROUP_FIELDS[field].toLowerCase()} was recorded.`,
        );
      }
    }

    const scored = all.filter((t) => parseRuleScore(t.rule_score));
    const full = scored.filter((t) => {
      const s = parseRuleScore(t.rule_score);
      return s.done === s.total;
    });
    const partial = scored.filter((t) => {
      const s = parseRuleScore(t.rule_score);
      return s.done < s.total;
    });
    compare(
      "rules:full",
      "Rule score",
      full,
      partial,
      (a, b) =>
        `Trades where you recorded following every rule averaged ${fmt(a.avgR)} over ${a.countedTrades} trades, compared with ${fmt(b.avgR)} over ${b.countedTrades} trades where you recorded missing at least one.`,
    );

    return out.sort((x, y) => Math.abs(y.groupAvgR - y.restAvgR) - Math.abs(x.groupAvgR - x.restAvgR));
  }

  const api = { SMALL_SAMPLE, MIN_GROUP, MIN_DIFF_R, summarise, breakdown, observations, parseRuleScore, tradeDate, sortByDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TradeAnalytics = api;
})(typeof window !== "undefined" ? window : this);
