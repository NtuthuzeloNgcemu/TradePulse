/* -----------------------------------------------
   TradePulse - CSV trade parser
   Pure functions with no Supabase or DOM dependencies, so they can
   be tested in Node (see tests/trade-parser.test.js).

   Principle: never guess. A value that could mean more than one
   thing is flagged for review instead of being converted.
----------------------------------------------- */

(function (root) {
  "use strict";

  const TRADE_COLUMN_ALIASES = {
    instrument: ["instrument", "symbol", "pair", "ticker", "market"],
    direction: ["direction", "side", "type", "buy/sell", "action"],
    session: ["session"],
    setup: ["setup", "strategy", "pattern"],
    entry_price: ["entry", "entry price", "open price", "open"],
    exit_price: ["exit", "exit price", "close price", "close"],
    entry_time: ["entry time", "open time", "date", "opened", "entry date"],
    exit_time: ["exit time", "close time", "closed", "exit date"],
    result_r: ["r", "r-multiple", "r multiple", "result (r)", "result r"],
    rule_score: ["rule score", "rules", "rule"],
    emotion: ["emotion", "feeling", "mood"],
    notes: ["notes", "comment", "comments"],
  };

  // Columns that often hold a result, but in an unknown unit (money, pips, R).
  // They are never imported as R. The user is told why.
  const UNCLEAR_RESULT_HEADERS = ["result", "profit", "pnl", "p/l", "p&l", "net profit", "return"];

  const FIELD_LABELS = {
    instrument: "Instrument",
    direction: "Direction",
    entry_price: "Entry price",
    exit_price: "Exit price",
    entry_time: "Entry time",
    exit_time: "Exit time",
    result_r: "Result (R)",
  };

  function normalizeHeader(header) {
    return String(header || "")
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, " ")
      .replace(/[^a-z0-9 /()&-]/g, "");
  }

  function buildTradeColumnMap(headers) {
    const map = {};
    const normalizedHeaders = headers.map(normalizeHeader);
    for (const [field, aliases] of Object.entries(TRADE_COLUMN_ALIASES)) {
      const normalizedAliases = aliases.map(normalizeHeader);
      const index = normalizedHeaders.findIndex((h) => normalizedAliases.includes(h));
      if (index !== -1) map[field] = headers[index];
    }
    return map;
  }

  function findDuplicateHeaders(headers) {
    const seen = new Map();
    const duplicates = new Set();
    for (const h of headers) {
      const key = normalizeHeader(h);
      if (!key) continue;
      if (seen.has(key)) duplicates.add(seen.get(key));
      else seen.set(key, String(h).trim());
    }
    return [...duplicates];
  }

  /**
   * Parse a number without guessing.
   * Returns { value, issue }. value is null when empty or unusable.
   *  - "1.5", "-2", "+0.75", ".5"     -> number
   *  - "39,120.5", "1,234,567"         -> thousands separators removed
   *  - "1.5R" (only when allowRSuffix) -> 1.5
   *  - "1,5", "1,500", "1.234,5"       -> flagged: comma could be a decimal point
   *  - "50%"                           -> flagged: percentage, not this unit
   */
  function parseNumber(raw, { allowRSuffix = false } = {}) {
    if (raw === undefined || raw === null) return { value: null, issue: null };
    let v = String(raw).trim().replace(/\s+/g, "");
    if (v === "") return { value: null, issue: null };

    if (v.includes("%")) {
      return { value: null, issue: `"${raw}" is a percentage, not a ${allowRSuffix ? "result in R" : "price"}` };
    }

    if (allowRSuffix) v = v.replace(/r$/i, "");
    v = v.replace(/^\+/, "");

    const plain = /^-?(\d+(\.\d+)?|\.\d+)$/;
    const thousandsWithDecimal = /^-?\d{1,3}(,\d{3})+\.\d+$/;
    const multiGroupThousands = /^-?\d{1,3}(,\d{3}){2,}$/;

    if (plain.test(v)) return { value: Number(v), issue: null };
    if (thousandsWithDecimal.test(v) || multiGroupThousands.test(v)) {
      return { value: Number(v.replace(/,/g, "")), issue: null };
    }
    if (/^-?[\d.]*,\d+$/.test(v)) {
      return { value: null, issue: `"${raw}" uses a comma, which could be a decimal point or a thousands separator` };
    }
    return { value: null, issue: `"${raw}" is not a number` };
  }

  function parseDirection(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === "") return { value: null, issue: null };
    const v = String(raw).trim().toLowerCase();
    if (["long", "buy", "b"].includes(v)) return { value: "long", issue: null };
    if (["short", "sell", "s"].includes(v)) return { value: "short", issue: null };
    return { value: null, issue: `"${raw}" is not a recognised direction (use long/short or buy/sell)` };
  }

  /**
   * Work out whether slash dates in a file are day-first or month-first.
   * Only decided when the file itself proves it (a first part above 12
   * means day-first, a second part above 12 means month-first).
   * Returns "dmy", "mdy", "ambiguous" or "conflict".
   */
  function inferSlashDateOrder(values) {
    let dayFirst = false;
    let monthFirst = false;
    for (const raw of values) {
      const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(String(raw || "").trim());
      if (!m) continue;
      if (Number(m[1]) > 12) dayFirst = true;
      if (Number(m[2]) > 12) monthFirst = true;
    }
    if (dayFirst && monthFirst) return "conflict";
    if (dayFirst) return "dmy";
    if (monthFirst) return "mdy";
    return "ambiguous";
  }

  function buildLocalDate(y, mo, d, h = 0, mi = 0, s = 0) {
    const date = new Date(y, mo - 1, d, h, mi, s);
    // Reject impossible dates such as 31/02 that JavaScript would roll over
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    if (h > 23 || mi > 59 || s > 59) return null;
    return date;
  }

  /**
   * Accepted formats:
   *  - ISO 8601 with a timezone: 2026-03-04T10:15:00Z, 2026-03-04T10:15:00+02:00
   *  - Without a timezone (read in the device time zone, reported to the user):
   *    2026-03-04, 2026-03-04 10:15, 2026.03.04 10:15:00 (MT4/MT5 style)
   *  - Slash dates (04/03/2026 10:15) only when the file shows which part is the day
   */
  function parseDate(raw, slashOrder) {
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return { value: null, issue: null, assumedLocal: false };
    }
    const v = String(raw).trim();

    const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
    if (isoWithZone.test(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime())
        ? { value: null, issue: `"${raw}" is not a valid date`, assumedLocal: false }
        : { value: d.toISOString(), issue: null, assumedLocal: false };
    }

    const ymd = /^(\d{4})[-.](\d{2})[-.](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
    if (ymd) {
      const [, y, mo, d, h, mi, s] = ymd.map((x) => (x === undefined ? undefined : Number(x)));
      const date = buildLocalDate(y, mo, d, h || 0, mi || 0, s || 0);
      return date
        ? { value: date.toISOString(), issue: null, assumedLocal: true }
        : { value: null, issue: `"${raw}" is not a valid date`, assumedLocal: false };
    }

    const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
    if (slash) {
      if (slashOrder !== "dmy" && slashOrder !== "mdy") {
        const why =
          slashOrder === "conflict"
            ? "this file mixes day-first and month-first dates"
            : "it could be day/month or month/day";
        return { value: null, issue: `"${raw}" is unclear because ${why}`, assumedLocal: false };
      }
      const [, a, b, y, h, mi, s] = slash.map((x) => (x === undefined ? undefined : Number(x)));
      const [d, mo] = slashOrder === "dmy" ? [a, b] : [b, a];
      const date = buildLocalDate(y, mo, d, h || 0, mi || 0, s || 0);
      return date
        ? { value: date.toISOString(), issue: null, assumedLocal: true }
        : { value: null, issue: `"${raw}" is not a valid date`, assumedLocal: false };
    }

    return { value: null, issue: `"${raw}" is not a date format TradePulse can read`, assumedLocal: false };
  }

  function cleanText(raw) {
    if (raw === undefined || raw === null) return null;
    const v = String(raw).trim();
    return v === "" ? null : v;
  }

  /**
   * Classify each row:
   *  - ready:   every recognised field parsed cleanly
   *  - review:  usable, but at least one field was unclear and would be left blank
   *  - skipped: no instrument, no usable result/entry/exit, or a broken row
   * A row needs an instrument AND at least one of {result_r, entry_price, exit_price}.
   * result_r only ever comes from an explicit R column. It is never derived
   * from prices, because that needs the original risk, which we don't have.
   */
  function parseTradesFromRows(rows, headers, { brokenRows = new Map() } = {}) {
    const columnMap = buildTradeColumnMap(headers);
    const slashOrder = inferSlashDateOrder(
      rows.flatMap((row) => [row[columnMap.entry_time], row[columnMap.exit_time]]),
    );

    const ready = [];
    const review = [];
    const skipped = [];
    let assumedLocalTime = false; // only counted for rows that can actually be imported

    rows.forEach((row, index) => {
      const rowNumber = index + 2; // +1 for the header line, +1 for 1-based numbering
      const get = (field) => (columnMap[field] ? row[columnMap[field]] : undefined);

      if (brokenRows.has(index)) {
        skipped.push({ rowNumber, reasons: [brokenRows.get(index)] });
        return;
      }

      const issues = [];
      let rowAssumedLocal = false;
      const take = (field, parsed) => {
        if (parsed.issue) issues.push({ field, message: `${FIELD_LABELS[field]}: ${parsed.issue}` });
        if (parsed.assumedLocal) rowAssumedLocal = true;
        return parsed.value;
      };

      const instrument = cleanText(get("instrument"));
      const trade = {
        instrument,
        direction: take("direction", parseDirection(get("direction"))),
        session: cleanText(get("session")),
        setup: cleanText(get("setup")),
        entry_price: take("entry_price", parseNumber(get("entry_price"))),
        exit_price: take("exit_price", parseNumber(get("exit_price"))),
        entry_time: take("entry_time", parseDate(get("entry_time"), slashOrder)),
        exit_time: take("exit_time", parseDate(get("exit_time"), slashOrder)),
        result_r: take("result_r", parseNumber(get("result_r"), { allowRSuffix: true })),
        rule_score: cleanText(get("rule_score")),
        emotion: cleanText(get("emotion")),
        notes: cleanText(get("notes")),
      };

      const reasons = issues.map((i) => i.message);
      if (!instrument) {
        skipped.push({ rowNumber, reasons: ["No instrument", ...reasons] });
        return;
      }
      if (trade.result_r === null && trade.entry_price === null && trade.exit_price === null) {
        skipped.push({
          rowNumber,
          instrument,
          reasons: reasons.length ? reasons : ["No result (R), entry price or exit price"],
        });
        return;
      }
      if (rowAssumedLocal) assumedLocalTime = true;
      if (issues.length) {
        review.push({ rowNumber, trade, reasons, fields: issues.map((i) => i.field) });
        return;
      }
      ready.push({ rowNumber, trade });
    });

    return { ready, review, skipped, columnMap, slashOrder, assumedLocalTime };
  }

  /**
   * Full CSV analysis. Papa is passed in so this file has no globals to load.
   * Returns { ok: false, reason } when the file as a whole can't be imported safely.
   */
  function analyseCsv(text, Papa) {
    const headerOnly = Papa.parse(text, { preview: 1, skipEmptyLines: true });
    const rawHeaders = (headerOnly.data[0] || []).map((h) => String(h).trim());

    if (!rawHeaders.length || rawHeaders.every((h) => h === "")) {
      return { ok: false, reason: "This file is empty or has no header row." };
    }

    const duplicates = findDuplicateHeaders(rawHeaders);
    if (duplicates.length) {
      return {
        ok: false,
        reason: `This file repeats some column names (${duplicates.join(", ")}), so TradePulse can't tell which column is which. Broker statements from MT4/MT5 are laid out like this and aren't supported yet.`,
      };
    }

    const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
    const headers = parsed.meta.fields || rawHeaders;
    const columnMap = buildTradeColumnMap(headers);

    if (!columnMap.instrument) {
      return {
        ok: false,
        reason: `TradePulse couldn't find an instrument column. Name one of your columns Instrument, Symbol, Pair, Ticker or Market.`,
      };
    }

    const brokenRows = new Map();
    for (const err of parsed.errors || []) {
      if (typeof err.row === "number") {
        brokenRows.set(err.row, "This row has a different number of columns from the header");
      }
    }

    const result = parseTradesFromRows(parsed.data, headers, { brokenRows });

    const notes = [];
    if (!columnMap.result_r) {
      const unclear = headers.filter((h) => UNCLEAR_RESULT_HEADERS.includes(normalizeHeader(h)));
      if (unclear.length) {
        notes.push(
          `The ${unclear.map((h) => `"${h}"`).join(", ")} column was not used as a result, because TradePulse can't tell whether it's in R, money or pips. Name the column "R" if it's an R multiple.`,
        );
      }
    }
    if (result.assumedLocalTime) {
      notes.push("Some times had no time zone, so they were read in your device's time zone.");
    }

    return { ok: true, totalRows: parsed.data.length, notes, ...result };
  }

  /**
   * A row is treated as a likely duplicate only when every recorded field
   * matches, so two genuinely different trades with the same result are
   * never merged. Duplicates are moved to "Needs review", never dropped.
   */
  const FINGERPRINT_FIELDS = [
    "instrument", "direction", "session", "setup", "entry_price", "exit_price",
    "entry_time", "exit_time", "result_r", "rule_score", "emotion", "notes",
  ];

  function tradeFingerprint(t) {
    return FINGERPRINT_FIELDS.map((f) => {
      let v = t[f];
      if (v === undefined || v === null || v === "") return "";
      if (f === "instrument") return String(v).trim().toUpperCase();
      if (f === "entry_time" || f === "exit_time") {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16); // to the minute
      }
      if (["entry_price", "exit_price", "result_r"].includes(f)) return String(Number(v));
      return String(v).trim().toLowerCase();
    }).join("|");
  }

  function markDuplicates(analysis, existingTrades = []) {
    const existing = new Set(existingTrades.map(tradeFingerprint));
    const seenInFile = new Map();
    const ready = [];
    const review = [...analysis.review];
    let duplicates = 0;

    const check = (row) => {
      const fp = tradeFingerprint(row.trade);
      const reasons = [];
      if (existing.has(fp)) reasons.push("Looks identical to a trade already in your journal");
      if (seenInFile.has(fp)) reasons.push(`Identical to row ${seenInFile.get(fp)} in this file`);
      else seenInFile.set(fp, row.rowNumber);
      return reasons;
    };

    for (const row of analysis.ready) {
      const reasons = check(row);
      if (reasons.length) {
        duplicates++;
        review.push({ ...row, reasons, fields: [], duplicate: true });
      } else ready.push(row);
    }
    for (let i = 0; i < review.length; i++) {
      if (review[i].duplicate) continue;
      const reasons = check(review[i]);
      if (reasons.length) {
        duplicates++;
        review[i] = { ...review[i], reasons: [...review[i].reasons, ...reasons], duplicate: true };
      }
    }
    review.sort((a, b) => a.rowNumber - b.rowNumber);
    return { ...analysis, ready, review, duplicates };
  }

  const api = {
    TRADE_COLUMN_ALIASES,
    tradeFingerprint,
    markDuplicates,
    normalizeHeader,
    buildTradeColumnMap,
    findDuplicateHeaders,
    parseNumber,
    parseDirection,
    parseDate,
    inferSlashDateOrder,
    parseTradesFromRows,
    analyseCsv,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TradeParser = api;
})(typeof window !== "undefined" ? window : this);
