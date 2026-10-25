/* -----------------------------------------------
   TradePulse - Journal page
   Trade ledger with search, and an editor to correct or
   delete any trade. Shows where each trade came from.
----------------------------------------------- */
(function () {
  const { escapeHtml, plural, formatResultR, formatDate } = TP;
  const section = document.getElementById("journalMainSection");
  const content = document.getElementById("journalMainContent");
  if (!section || !content) return;

  let shown = 100;
  let filter = "";
  let trades = [];
  let sourcesById = new Map();

  function matches(t) {
    if (!filter) return true;
    const q = filter.toLowerCase();
    if (q === "no r") return !Number.isFinite(t.result_r);
    return [t.instrument, t.setup, t.session, t.direction, t.emotion, t.notes].some((v) => String(v || "").toLowerCase().includes(q));
  }

  function provenance(t) {
    if (!t.source_id) return t.import_notes ? "Imported (file since deleted)" : "Entered manually";
    const s = sourcesById.get(t.source_id);
    if (!s) return "Imported";
    return s.extracted_by ? `AI-read from ${s.file_name}` : `Imported from ${s.file_name}`;
  }

  async function render() {
    TP.regionLoading(content, "Loading your trades.");
    try {
      const [t, s] = await Promise.all([TP.getTrades(), TP.getSources().catch(() => [])]);
      trades = t;
      sourcesById = new Map(s.map((x) => [x.id, x]));
    } catch (err) {
      section.classList.add("empty");
      TP.regionError(content, "Your trades couldn't be loaded.", "trades");
      return;
    }
    content.removeAttribute("aria-busy");

    if (!trades.length) {
      section.classList.add("empty");
      TP.restoreTemplate(content);
      return;
    }
    section.classList.remove("empty");
    paint();
  }

  function paint() {
    const list = trades.filter(matches);
    const rows = list
      .slice(0, shown)
      .map((t) => {
        const r = formatResultR(t.result_r);
        return `
        <button class="trade-row trade-row-button" type="button" data-trade-id="${escapeHtml(t.id)}" aria-label="Open ${escapeHtml(t.instrument)} trade">
          <span class="trade-secondary">${escapeHtml(t.entry_time || t.exit_time ? formatDate(t.entry_time || t.exit_time) : "No date")}</span>
          <span class="trade-instrument">${escapeHtml(t.instrument)}</span>
          <span class="trade-secondary">${escapeHtml(t.direction || "-")}</span>
          <span class="trade-secondary">${escapeHtml(t.setup || t.session || "-")}</span>
          <span class="trade-secondary trade-col-source">${escapeHtml(provenance(t))}</span>
          <span class="trade-result ${r.cls}">${r.text}</span>
        </button>`;
      })
      .join("");
    const withoutR = trades.filter((t) => !Number.isFinite(t.result_r)).length;

    content.innerHTML = `
      <div class="journal-list-header">
        <h2>${plural(trades.length, "trade", "trades")} logged.</h2>
        <label class="journal-search"><span class="visually-hidden">Search trades</span>
          <input type="search" id="journalSearch" placeholder="Search instrument, setup, notes" value="${escapeHtml(filter)}" />
        </label>
      </div>
      ${withoutR ? `<p class="card-copy journal-note">${plural(withoutR, "trade has", "trades have")} no result in R and ${withoutR === 1 ? "isn't" : "aren't"} counted in analytics. <button class="link-button" type="button" data-filter="no r">Show ${withoutR === 1 ? "it" : "them"}</button></p>` : ""}
      ${filter ? `<p class="card-copy journal-note">Showing ${plural(list.length, "match", "matches")}. <button class="link-button" type="button" data-filter="">Clear search</button></p>` : ""}
      <div class="trade-list trade-list-wide">
        <div class="trade-list-head">
          <span>Date</span><span>Instrument</span><span>Direction</span><span>Setup</span><span class="trade-col-source">Source</span><span style="text-align:end">Result</span>
        </div>
        ${rows || `<p class="card-copy" style="padding:16px 4px">No trades match.</p>`}
      </div>
      ${list.length > shown ? `<button class="link-button journal-more" type="button" id="journalMore">Show ${Math.min(100, list.length - shown)} more of ${list.length - shown} remaining</button>` : ""}`;
  }

  content.addEventListener("input", (event) => {
    if (event.target.id !== "journalSearch") return;
    filter = event.target.value.trim();
    shown = 100;
    const pos = event.target.selectionStart;
    paint();
    const input = document.getElementById("journalSearch");
    input.focus();
    input.setSelectionRange(pos, pos);
  });

  content.addEventListener("click", (event) => {
    const f = event.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      shown = 100;
      return paint();
    }
    if (event.target.closest("#journalMore")) {
      shown += 100;
      return paint();
    }
    const row = event.target.closest("[data-trade-id]");
    if (row) openEditor(trades.find((t) => t.id === row.dataset.tradeId));
  });

  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const val = (v) => escapeHtml(v ?? "");

  function openEditor(t) {
    if (!t) return;
    const s = t.source_id ? sourcesById.get(t.source_id) : null;
    const origin = t.source_id
      ? `${s?.extracted_by ? "Found by AI in" : "Imported from"} <strong>${escapeHtml(s?.file_name || "a file")}</strong> on ${escapeHtml(formatDate(t.created_at))}.`
      : t.import_notes
        ? "Imported from a file that has since been deleted."
        : `Entered manually on ${escapeHtml(formatDate(t.created_at))}.`;

    const d = TP.createDialog({
      title: `${t.instrument} trade`,
      wide: true,
      html: `
        <div class="provenance">
          <p class="label">Where this came from</p>
          <p class="card-copy">${origin}${t.updated_at ? ` Last edited ${escapeHtml(formatDate(t.updated_at, true))}.` : ""}</p>
          ${t.import_notes ? `<p class="card-copy provenance-notes">${escapeHtml(t.import_notes)}</p>` : ""}
        </div>
        <form class="manual-entry-form trade-editor" id="tradeEditor" novalidate>
          <div class="form-row">
            <div class="field-group"><label for="edInstrument">Instrument</label><input id="edInstrument" value="${val(t.instrument)}" required /></div>
            <div class="field-group"><label for="edDirection">Direction</label>
              <select id="edDirection"><option value="">Not specified</option><option value="long"${t.direction === "long" ? " selected" : ""}>Long</option><option value="short"${t.direction === "short" ? " selected" : ""}>Short</option></select></div>
          </div>
          <div class="form-row">
            <div class="field-group"><label for="edSession">Session</label><input id="edSession" value="${val(t.session)}" /></div>
            <div class="field-group"><label for="edSetup">Setup</label><input id="edSetup" value="${val(t.setup)}" /></div>
          </div>
          <div class="form-row">
            <div class="field-group"><label for="edEntryTime">Entry time</label><input type="datetime-local" id="edEntryTime" value="${toLocalInput(t.entry_time)}" /></div>
            <div class="field-group"><label for="edExitTime">Exit time</label><input type="datetime-local" id="edExitTime" value="${toLocalInput(t.exit_time)}" /></div>
          </div>
          <div class="form-row">
            <div class="field-group"><label for="edEntryPrice">Entry price</label><input type="number" step="any" id="edEntryPrice" value="${val(t.entry_price)}" /></div>
            <div class="field-group"><label for="edExitPrice">Exit price</label><input type="number" step="any" id="edExitPrice" value="${val(t.exit_price)}" /></div>
          </div>
          <div class="form-row">
            <div class="field-group"><label for="edResultR">Result (R)</label><input type="number" step="any" id="edResultR" value="${val(t.result_r)}" /></div>
            <div class="field-group"><label for="edRuleScore">Rule score</label><input id="edRuleScore" value="${val(t.rule_score)}" placeholder="4/4" /></div>
          </div>
          <div class="field-group"><label for="edEmotion">Emotion</label><input id="edEmotion" value="${val(t.emotion)}" /></div>
          <div class="field-group"><label for="edNotes">Notes</label><textarea id="edNotes" rows="3">${val(t.notes)}</textarea></div>
          <span class="field-error" id="edError" role="alert"></span>
          <div class="review-actions review-actions-split">
            <button class="button button-danger-outline" type="button" id="edDelete">Delete trade</button>
            <span class="review-actions">
              <button class="button button-paper" type="button" data-dialog-close="true">Cancel</button>
              <button class="button button-ink" type="submit" id="edSave">Save changes</button>
            </span>
          </div>
        </form>`,
    });

    const root = d.root;
    const errEl = root.querySelector("#edError");
    const iso = (id) => {
      const raw = root.querySelector(id).value;
      if (!raw) return null;
      const x = new Date(raw);
      return Number.isNaN(x.getTime()) ? null : x.toISOString();
    };
    const num = (id) => {
      const raw = root.querySelector(id).value;
      return raw === "" ? null : Number(raw);
    };
    const text = (id) => root.querySelector(id).value.trim() || null;

    root.querySelector("#tradeEditor").addEventListener("submit", async (event) => {
      event.preventDefault();
      errEl.textContent = "";
      const instrument = text("#edInstrument");
      if (!instrument) {
        errEl.textContent = "Enter an instrument.";
        return root.querySelector("#edInstrument").focus();
      }
      for (const id of ["#edEntryPrice", "#edExitPrice", "#edResultR"]) {
        const v = num(id);
        if (v !== null && !Number.isFinite(v)) {
          errEl.textContent = "Numbers must be plain numbers, like 1.5 or -1.";
          return root.querySelector(id).focus();
        }
      }
      const entry = iso("#edEntryTime");
      const exit = iso("#edExitTime");
      if (entry && exit && exit < entry) {
        errEl.textContent = "The exit time is before the entry time.";
        return root.querySelector("#edExitTime").focus();
      }
      const btn = root.querySelector("#edSave");
      btn.disabled = true;
      btn.textContent = "Saving...";
      const changes = {
        instrument,
        direction: text("#edDirection"),
        session: text("#edSession"),
        setup: text("#edSetup"),
        entry_time: entry,
        exit_time: exit,
        entry_price: num("#edEntryPrice"),
        exit_price: num("#edExitPrice"),
        result_r: num("#edResultR"),
        rule_score: text("#edRuleScore"),
        emotion: text("#edEmotion"),
        notes: text("#edNotes"),
        updated_at: new Date().toISOString(),
      };
      const { error } = await tpClient.from("trades").update(changes).eq("id", t.id);
      if (error) {
        errEl.textContent = `Couldn't save: ${error.message}`;
        btn.disabled = false;
        btn.textContent = "Save changes";
        return;
      }
      d.close();
      TP.emitDataChanged("trades");
    });

    root.querySelector("#edDelete").addEventListener("click", async (event) => {
      const btn = event.currentTarget;
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Click again to delete permanently";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Deleting...";
      const { error } = await tpClient.from("trades").delete().eq("id", t.id);
      if (error) {
        errEl.textContent = `Couldn't delete: ${error.message}`;
        btn.disabled = false;
        btn.dataset.armed = "";
        btn.textContent = "Delete trade";
        return;
      }
      d.close();
      TP.emitDataChanged("trades");
    });
  }

  TP.ready.then(render);
  document.addEventListener("tp:data-changed", (e) => {
    if (!e.detail.kind || ["trades", "sources"].includes(e.detail.kind)) render();
  });
})();
