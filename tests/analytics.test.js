// Analytics formulas and duplicate detection. Fixtures here are test data only.
process.env.TZ = "Africa/Johannesburg";

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analytics.js");
const P = require("../trade-parser.js");
const Papa = require("papaparse");

const t = (r, extra = {}) => ({ instrument: "EURUSD", result_r: r, ...extra });

test("summary: win rate excludes breakeven, R metrics exclude trades without R", () => {
  const s = A.summarise([t(2), t(-1), t(0), t(1), t(null), t("1.5")]);
  assert.equal(s.totalTrades, 6);
  assert.equal(s.countedTrades, 5);
  assert.equal(s.withoutResult, 1);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.winRate, 0.75); // 3 / (3 + 1), breakeven excluded
  assert.equal(s.netR, 3.5);
  assert.equal(s.avgR, 0.7);
  assert.equal(s.avgWin, 1.5);
  assert.equal(s.avgLoss, -1);
  assert.equal(s.profitFactor, 4.5);
  assert.equal(s.largestLoss, -1);
  assert.equal(s.smallSample, true);
});

test("summary: empty and all-breakeven inputs give nulls, not zeros", () => {
  const e = A.summarise([]);
  assert.equal(e.winRate, null);
  assert.equal(e.netR, null);
  assert.equal(e.maxDrawdownR, null);
  const b = A.summarise([t(0), t(0)]);
  assert.equal(b.winRate, null);
  assert.equal(b.profitFactor, null);
  assert.equal(b.netR, 0);
});

test("summary: max drawdown follows trade date order, not insertion order", () => {
  const trades = [
    t(-2, { entry_time: "2026-03-04T10:00:00Z" }),
    t(3, { entry_time: "2026-03-01T10:00:00Z" }),
    t(-1, { entry_time: "2026-03-05T10:00:00Z" }),
    t(1, { entry_time: "2026-03-06T10:00:00Z" }),
  ];
  // Ordered: +3 (peak 3), -2 (1), -1 (0) -> drawdown 3, then +1
  assert.equal(A.summarise(trades).maxDrawdownR, 3);
  assert.equal(A.summarise(trades).firstDate, "2026-03-01T10:00:00Z");
  assert.equal(A.summarise(trades).lastDate, "2026-03-06T10:00:00Z");
});

test("rule adherence only uses valid x/y scores", () => {
  assert.deepEqual(A.parseRuleScore("3/4"), { done: 3, total: 4 });
  assert.equal(A.parseRuleScore("5/4"), null);
  assert.equal(A.parseRuleScore("0/0"), null);
  assert.equal(A.parseRuleScore("good"), null);
  const s = A.summarise([t(1, { rule_score: "4/4" }), t(1, { rule_score: "2/4" }), t(1, { rule_score: "great" })]);
  assert.equal(s.ruleAdherence, 0.75);
  assert.equal(s.ruleScoredTrades, 2);
});

test("breakdown groups by field and marks small groups", () => {
  const rows = A.breakdown([t(1, { session: "London" }), t(-1, { session: "London" }), t(2, { session: "NY" }), t(1)], "session");
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.netR]), [["London", 2, 0], ["NY", 1, 2], ["Not recorded", 1, 1]]);
  assert.ok(rows.every((r) => r.tooFew));
});

test("observations: none below 20 counted trades", () => {
  const few = Array.from({ length: 19 }, (_, i) => t(i % 2 ? 2 : -1, { session: i < 10 ? "London" : "NY" }));
  assert.deepEqual(A.observations(few), []);
});

test("observations: reported only with 10+ trades each side and a 0.5R+ difference", () => {
  const london = Array.from({ length: 12 }, () => t(1, { session: "London" }));
  const ny = Array.from({ length: 12 }, () => t(-0.5, { session: "NY" }));
  const obs = A.observations([...london, ...ny]);
  const ldn = obs.find((o) => o.id === "session:London");
  assert.ok(ldn);
  assert.equal(ldn.groupCount, 12);
  assert.equal(ldn.restCount, 12);
  assert.equal(ldn.direction, "better");
  assert.match(ldn.claim, /averaged \+1\.00R over 12 trades, compared with -0\.50R over 12/);
  assert.equal(ldn.evidence.length, 12);

  const close = [...Array.from({ length: 12 }, () => t(1, { session: "London" })), ...Array.from({ length: 12 }, () => t(0.7, { session: "NY" }))];
  assert.equal(A.observations(close).filter((o) => o.id.startsWith("session")).length, 0);
});

test("duplicates: identical rows are flagged, different trades with the same result are not", () => {
  const csv = "Symbol,Date,R\nEURUSD,2026-03-04 10:15,1\nEURUSD,2026-03-04 10:15,1\nEURUSD,2026-03-05 09:00,1\nGBPUSD,2026-03-06 09:00,-1\n";
  const analysis = P.analyseCsv(csv, Papa);
  const existing = [{ instrument: "gbpusd", entry_time: "2026-03-06T07:00:00.000Z", result_r: -1 }];
  const r = P.markDuplicates(analysis, existing);
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.ready.map((x) => x.rowNumber), [2, 4]);
  const byRow = Object.fromEntries(r.review.map((x) => [x.rowNumber, x.reasons.join(" | ")]));
  assert.match(byRow[3], /Identical to row 2/);
  assert.match(byRow[5], /already in your journal/);
});

test("observations: two groups produce one comparison, not two mirror images", () => {
  const london = Array.from({ length: 12 }, () => t(1, { session: "London" }));
  const ny = Array.from({ length: 11 }, () => t(-0.5, { session: "NY" }));
  const sessions = A.observations([...london, ...ny]).filter((o) => o.id.startsWith("session:"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "session:London");
});
