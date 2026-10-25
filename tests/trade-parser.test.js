// Run with: npm test   (uses Node's built-in test runner, Node 18+)
// Times are checked in a fixed zone so results don't depend on the machine.
process.env.TZ = "Africa/Johannesburg";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Papa = require("papaparse");
const P = require("../trade-parser.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("numbers: plain values, signs and thousands separators", () => {
  assert.deepEqual(P.parseNumber("1.5"), { value: 1.5, issue: null });
  assert.deepEqual(P.parseNumber("+2"), { value: 2, issue: null });
  assert.deepEqual(P.parseNumber("-0.75"), { value: -0.75, issue: null });
  assert.deepEqual(P.parseNumber(".5"), { value: 0.5, issue: null });
  assert.deepEqual(P.parseNumber("39,120.5"), { value: 39120.5, issue: null });
  assert.deepEqual(P.parseNumber("1,234,567"), { value: 1234567, issue: null });
  assert.deepEqual(P.parseNumber(""), { value: null, issue: null });
  assert.deepEqual(P.parseNumber(undefined), { value: null, issue: null });
});

test("numbers: comma decimals are flagged, never converted", () => {
  for (const v of ["1,5", "-0,75", "1,500", "1.234,5"]) {
    const r = P.parseNumber(v);
    assert.equal(r.value, null, v);
    assert.match(r.issue, /comma/, v);
  }
});

test("numbers: percentages and junk are flagged", () => {
  assert.equal(P.parseNumber("50%", { allowRSuffix: true }).value, null);
  assert.match(P.parseNumber("50%", { allowRSuffix: true }).issue, /percentage/);
  assert.match(P.parseNumber("abc").issue, /not a number/);
  assert.match(P.parseNumber("1.2.3").issue, /not a number/);
});

test("numbers: R suffix accepted only for R values", () => {
  assert.deepEqual(P.parseNumber("+1.5R", { allowRSuffix: true }), { value: 1.5, issue: null });
  assert.deepEqual(P.parseNumber("-1r", { allowRSuffix: true }), { value: -1, issue: null });
  assert.match(P.parseNumber("1.5R").issue, /not a number/);
});

test("direction: only clear values are accepted", () => {
  assert.equal(P.parseDirection("Buy").value, "long");
  assert.equal(P.parseDirection(" LONG ").value, "long");
  assert.equal(P.parseDirection("s").value, "short");
  assert.equal(P.parseDirection("").value, null);
  assert.equal(P.parseDirection("").issue, null);
  for (const v of ["Buy Limit", "sell stop", "balance"]) {
    assert.equal(P.parseDirection(v).value, null, v);
    assert.match(P.parseDirection(v).issue, /not a recognised direction/, v);
  }
});

test("dates: ISO with zone, ISO without zone and MT4/MT5 style", () => {
  assert.equal(P.parseDate("2026-03-05T14:00:00Z").value, "2026-03-05T14:00:00.000Z");
  assert.equal(P.parseDate("2026-03-05T14:00:00+02:00").value, "2026-03-05T12:00:00.000Z");
  const naive = P.parseDate("2026-03-04 10:15");
  assert.equal(naive.value, "2026-03-04T08:15:00.000Z"); // read as SAST (UTC+2)
  assert.equal(naive.assumedLocal, true);
  assert.equal(P.parseDate("2026.03.06 02:30:00").value, "2026-03-06T00:30:00.000Z");
  assert.match(P.parseDate("2026-02-31").issue, /not a valid date/);
  assert.match(P.parseDate("March 4").issue, /can read/);
});

test("dates: slash dates only when the file proves the order", () => {
  assert.equal(P.inferSlashDateOrder(["03/04/2026", "13/04/2026"]), "dmy");
  assert.equal(P.inferSlashDateOrder(["04/13/2026"]), "mdy");
  assert.equal(P.inferSlashDateOrder(["03/04/2026"]), "ambiguous");
  assert.equal(P.inferSlashDateOrder(["13/04/2026", "04/13/2026"]), "conflict");

  assert.equal(P.parseDate("03/04/2026", "dmy").value, "2026-04-02T22:00:00.000Z"); // 3 April SAST
  assert.equal(P.parseDate("03/04/2026", "mdy").value, "2026-03-03T22:00:00.000Z"); // 4 March SAST
  assert.match(P.parseDate("03/04/2026", "ambiguous").issue, /day\/month or month\/day/);
  assert.match(P.parseDate("13/04/2026", "conflict").issue, /mixes/);
});

test("clean file: every row ready, values exact", () => {
  const r = P.analyseCsv(fixture("clean.csv"), Papa);
  assert.equal(r.ok, true);
  assert.equal(r.ready.length, 3);
  assert.equal(r.review.length, 0);
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(
    r.ready.map((x) => [x.trade.instrument, x.trade.direction, x.trade.result_r, x.trade.rule_score]),
    [
      ["EURUSD", "long", 1.5, "4/4"],
      ["GBPUSD", "short", -1, "3/4"],
      ["XAUUSD", "long", 0, "4/4"],
    ],
  );
  assert.equal(r.ready[0].trade.entry_time, "2026-03-04T08:15:00.000Z");
  assert.ok(r.notes.some((n) => /time zone/.test(n)));
});

test("decimal-comma file: nothing is imported with an inflated value", () => {
  const r = P.analyseCsv(fixture("eu-decimal-comma.csv"), Papa);
  assert.equal(r.ok, true);
  assert.equal(r.ready.length, 0);
  assert.equal(r.review.length, 0);
  assert.equal(r.skipped.length, 2);
  for (const s of r.skipped) assert.ok(s.reasons.some((m) => /comma/.test(m)));
  // No row anywhere carries 15 or -75
  const values = [...r.ready, ...r.review].map((x) => x.trade.result_r);
  assert.ok(!values.includes(15) && !values.includes(-75));
});

test("MT5 positions export: refused with a clear reason", () => {
  const r = P.analyseCsv(fixture("mt5-positions.csv"), Papa);
  assert.equal(r.ok, false);
  assert.match(r.reason, /repeats some column names \(Time, Price\)/);
});

test("messy file: each row lands in the right group with a reason", () => {
  const r = P.analyseCsv(fixture("messy.csv"), Papa);
  assert.equal(r.ok, true);
  assert.equal(r.slashOrder, "dmy");

  assert.deepEqual(r.ready.map((x) => [x.rowNumber, x.trade.instrument, x.trade.direction, x.trade.result_r]), [
    [4, "NAS100", "short", 0.8],
  ]);
  assert.equal(r.ready[0].trade.entry_time, "2026-04-13T22:00:00.000Z"); // 14 April SAST

  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].rowNumber, 2);
  assert.deepEqual(r.review[0].fields, ["direction"]);
  assert.equal(r.review[0].trade.direction, null);
  assert.equal(r.review[0].trade.result_r, 1);

  const skipped = Object.fromEntries(r.skipped.map((s) => [s.rowNumber, s.reasons.join(" | ")]));
  assert.match(skipped[3], /percentage/); // US30 50%
  assert.match(skipped[5], /No instrument/);
  assert.match(skipped[6], /different number of columns/); // GBPUSD,sell
});

test("a Result column in unknown units is never used as R", () => {
  const r = P.analyseCsv("Symbol,Result\nEURUSD,120\n", Papa);
  assert.equal(r.ok, true);
  assert.equal(r.ready.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.ok(r.notes.some((n) => /"Result" column was not used/.test(n)));
});

test("files without an instrument column or header are refused", () => {
  assert.equal(P.analyseCsv("Date,R\n2026-01-01,1\n", Papa).ok, false);
  assert.equal(P.analyseCsv("", Papa).ok, false);
});

test("time zone note only appears when an importable row used a local time", () => {
  const skippedOnly = P.analyseCsv(fixture("eu-decimal-comma.csv"), Papa);
  assert.ok(!skippedOnly.notes.some((n) => /time zone/.test(n)));
  const withZone = P.analyseCsv("Symbol,Date,R\nEURUSD,2026-03-05T14:00:00Z,1\n", Papa);
  assert.ok(!withZone.notes.some((n) => /time zone/.test(n)));
});
