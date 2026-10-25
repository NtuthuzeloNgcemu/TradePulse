/* -----------------------------------------------
   TradePulse - Playbook page
   Rules you write are active straight away. Rules the AI found in
   your documents stay "suggested" until you accept them, and always
   show the text and file they came from. The database enforces this
   (see supabase/migrations/..._hardening_part1_...).
----------------------------------------------- */
(function () {
  const root = document.getElementById("playbookContent");
  if (!root) return;
  const { escapeHtml, plural, formatDate } = TP;

  let rules = [];
  let sourcesById = new Map();

  function ruleCard(r) {
    const src = r.source_id ? sourcesById.get(r.source_id) : null;
    const from =
      r.origin === "ai"
        ? `Suggested by AI from ${src ? `<strong>${escapeHtml(src.file_name)}</strong>` : "a file that has since been deleted"} on ${escapeHtml(formatDate(r.created_at))}.`
        : `Added by you on ${escapeHtml(formatDate(r.created_at))}.`;
    const actions = {
      suggested: `<button class="button button-ink button-small" type="button" data-rule-action="accept">Accept</button>
                  <button class="link-button" type="button" data-rule-action="edit">Edit, then accept</button>
                  <button class="link-button link-danger" type="button" data-rule-action="reject">Reject</button>`,
      confirmed: `<button class="link-button" type="button" data-rule-action="edit">Edit</button>
                  <button class="link-button" type="button" data-rule-action="archive">Archive</button>`,
      archived: `<button class="link-button" type="button" data-rule-action="restore">Make active again</button>
                 <button class="link-button link-danger" type="button" data-rule-action="delete">Delete</button>`,
      rejected: `<button class="link-button" type="button" data-rule-action="restore">Accept after all</button>
                 <button class="link-button link-danger" type="button" data-rule-action="delete">Delete</button>`,
    }[r.status];
    return `
      <div class="rule-card" data-rule-id="${escapeHtml(r.id)}">
        <p class="rule-text">${escapeHtml(r.rule_text)}</p>
        ${r.evidence ? `<p class="rule-evidence">Source text: "${escapeHtml(r.evidence)}"</p>` : ""}
        <p class="rule-meta">${from}${r.updated_at && r.status !== "suggested" ? ` Updated ${escapeHtml(formatDate(r.updated_at))}.` : ""}</p>
        <div class="rule-actions">${actions}</div>
        <div class="rule-edit" hidden></div>
      </div>`;
  }

  function paint() {
    const suggested = rules.filter((r) => r.status === "suggested");
    const active = rules.filter((r) => r.status === "confirmed");
    const inactive = rules.filter((r) => r.status === "archived" || r.status === "rejected");

    root.innerHTML = `
      <section class="surface card-pad">
        <p class="label">Add a rule</p>
        <form class="rule-add" id="ruleAddForm" novalidate>
          <label class="visually-hidden" for="ruleAddText">Rule</label>
          <textarea id="ruleAddText" rows="2" maxlength="300" placeholder="For example: Only take trades during the London session."></textarea>
          <div class="rule-add-row">
            <span class="field-error" id="ruleAddError" role="alert"></span>
            <button class="button button-ink button-small" type="submit">Add rule</button>
          </div>
        </form>
        <p class="card-copy">Or <button class="link-button" type="button" data-open-upload>upload a strategy document</button> (PDF or TXT) and use "Read with AI" to find the rules you've written in it.</p>
      </section>

      ${
        suggested.length
          ? `<section class="surface card-pad rules-section">
              <p class="label">Suggestions to review</p>
              <h2 class="card-title">${plural(suggested.length, "rule was", "rules were")} found in your documents.</h2>
              <p class="card-copy">They aren't part of your playbook until you accept them. Check each one against the source text.</p>
              ${suggested.map(ruleCard).join("")}
            </section>`
          : ""
      }

      <section class="surface card-pad rules-section">
        <p class="label">Active rules</p>
        ${
          active.length
            ? `<h2 class="card-title">${plural(active.length, "rule", "rules")} in your playbook.</h2>${active.map(ruleCard).join("")}`
            : `<h2 class="card-title">None yet.</h2><p class="card-copy">Only rules you add or accept become part of your playbook.</p>`
        }
      </section>

      ${
        inactive.length
          ? `<details class="surface card-pad rules-section">
              <summary>${plural(inactive.length, "archived or rejected rule", "archived or rejected rules")}</summary>
              ${inactive.map(ruleCard).join("")}
            </details>`
          : ""
      }

      <p class="card-copy playbook-note">TradePulse doesn't check whether your trades followed these rules. Use the rule score on each trade (for example 3/4) to record that yourself.</p>`;
  }

  async function update(id, changes) {
    const { error } = await tpClient.from("playbook_rules").update(changes).eq("id", id);
    if (error) throw error;
  }

  root.addEventListener("submit", async (e) => {
    if (e.target.id === "ruleAddForm") {
      e.preventDefault();
      const input = root.querySelector("#ruleAddText");
      const err = root.querySelector("#ruleAddError");
      const text = input.value.trim();
      err.textContent = "";
      if (!text) {
        err.textContent = "Write the rule first.";
        return input.focus();
      }
      const { error } = await tpClient.from("playbook_rules").insert({ user_id: TP.user.id, rule_text: text, status: "confirmed", origin: "user" });
      if (error) {
        err.textContent = `Couldn't add the rule: ${error.message}`;
        return;
      }
      TP.emitDataChanged("rules");
    }
    if (e.target.classList.contains("rule-edit-form")) {
      e.preventDefault();
      const card = e.target.closest("[data-rule-id]");
      const text = e.target.querySelector("textarea").value.trim();
      const err = e.target.querySelector(".field-error");
      if (!text) {
        err.textContent = "A rule can't be empty.";
        return;
      }
      try {
        await update(card.dataset.ruleId, { rule_text: text, status: "confirmed" });
        TP.emitDataChanged("rules");
      } catch (x) {
        err.textContent = `Couldn't save: ${x.message}`;
      }
    }
  });

  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-rule-action]");
    if (!btn) return;
    const card = btn.closest("[data-rule-id]");
    const id = card.dataset.ruleId;
    const rule = rules.find((r) => r.id === id);
    const action = btn.dataset.ruleAction;

    if (action === "edit") {
      const box = card.querySelector(".rule-edit");
      box.hidden = false;
      box.innerHTML = `
        <form class="rule-edit-form" novalidate>
          <label class="visually-hidden" for="edit-${escapeHtml(id)}">Edit rule</label>
          <textarea id="edit-${escapeHtml(id)}" rows="2" maxlength="300">${escapeHtml(rule.rule_text)}</textarea>
          <div class="rule-add-row"><span class="field-error" role="alert"></span>
            <span><button class="link-button" type="button" data-rule-action="cancel-edit">Cancel</button>
            <button class="button button-ink button-small" type="submit">${rule.status === "suggested" ? "Save and accept" : "Save"}</button></span></div>
        </form>`;
      return box.querySelector("textarea").focus();
    }
    if (action === "cancel-edit") {
      const box = card.querySelector(".rule-edit");
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    if (action === "delete" && btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to delete";
      return;
    }

    btn.disabled = true;
    try {
      if (action === "accept" || action === "restore") await update(id, { status: "confirmed" });
      if (action === "reject") await update(id, { status: "rejected" });
      if (action === "archive") await update(id, { status: "archived" });
      if (action === "delete") {
        const { error } = await tpClient.from("playbook_rules").delete().eq("id", id);
        if (error) throw error;
      }
      TP.emitDataChanged("rules");
    } catch (x) {
      btn.disabled = false;
      card.querySelector(".rule-meta").insertAdjacentHTML("beforeend", ` <span class="field-error">That didn't work: ${escapeHtml(x.message)}</span>`);
    }
  });

  async function render() {
    TP.regionLoading(root, "Loading your playbook.");
    try {
      const [r, s] = await Promise.all([TP.getRules(), TP.getSources().catch(() => [])]);
      rules = r;
      sourcesById = new Map(s.map((x) => [x.id, x]));
    } catch (err) {
      TP.regionError(root, "Your playbook couldn't be loaded.", "rules");
      return;
    }
    root.removeAttribute("aria-busy");
    paint();
  }

  TP.ready.then(render);
  document.addEventListener("tp:data-changed", (e) => {
    if (!e.detail.kind || ["rules", "sources"].includes(e.detail.kind)) render();
  });
})();
