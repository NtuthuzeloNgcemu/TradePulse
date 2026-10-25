/* -----------------------------------------------
   TradePulse - Account page
   Profile, password, billing status, data export and
   account deletion (via the delete-account Edge Function).
----------------------------------------------- */
(function () {
  if (!document.querySelector('[data-page="account"]')) return;
  const { escapeHtml } = TP;
  const $ = (id) => document.getElementById(id);

  function status(el, message, ok = false) {
    el.textContent = message;
    el.classList.toggle("is-ok", ok);
  }

  TP.ready.then(async (user) => {
    $("accountEmail").textContent = user.email;
    try {
      const { data, error } = await tpClient.from("profiles").select("first_name, last_name, trader_type").eq("id", user.id).single();
      if (error) throw error;
      $("accFirstName").value = data.first_name || "";
      $("accLastName").value = data.last_name || "";
      $("accTraderType").value = data.trader_type || "";
    } catch (err) {
      status($("profileStatus"), "Your profile couldn't be loaded. Refresh to try again.");
    }
  });

  $("profileForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("profileStatus");
    const first = $("accFirstName").value.trim();
    if (!first) return status(out, "Enter your first name.");
    const { error } = await tpClient
      .from("profiles")
      .update({ first_name: first, last_name: $("accLastName").value.trim() || null, trader_type: $("accTraderType").value || null })
      .eq("id", TP.user.id);
    status(out, error ? `Couldn't save: ${error.message}` : "Saved.", !error);
  });

  $("passwordForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("passwordStatus");
    const pw = $("accNewPassword").value;
    if (pw.length < 8) return status(out, "Use at least 8 characters.");
    if (pw !== $("accConfirmPassword").value) return status(out, "The two passwords don't match.");
    const { error } = await tpClient.auth.updateUser({ password: pw });
    if (error) return status(out, error.message);
    e.target.reset();
    status(out, "Password changed.", true);
  });

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  const csvCell = (v) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Stop spreadsheet apps from treating a value as a formula
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  $("exportCsv")?.addEventListener("click", async () => {
    const out = $("exportStatus");
    try {
      const trades = await TP.getTrades();
      const cols = ["instrument", "direction", "session", "setup", "entry_time", "exit_time", "entry_price", "exit_price", "result_r", "rule_score", "emotion", "notes", "import_notes", "created_at"];
      const lines = [cols.join(","), ...trades.map((t) => cols.map((c) => csvCell(t[c])).join(","))];
      download(`tradepulse-trades-${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\r\n"), "text/csv");
      status(out, `Downloaded ${trades.length} trades.`, true);
    } catch (err) {
      status(out, "Your trades couldn't be exported. Try again.");
    }
  });

  $("exportJson")?.addEventListener("click", async () => {
    const out = $("exportStatus");
    try {
      const [trades, sources, rules, profile] = await Promise.all([
        TP.getTrades(),
        TP.getSources(),
        TP.getRules(),
        tpClient.from("profiles").select("*").eq("id", TP.user.id).single().then((r) => r.data),
      ]);
      const data = { exported_at: new Date().toISOString(), account: { email: TP.user.email, profile }, trades, sources, playbook_rules: rules };
      download(`tradepulse-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
      status(out, "Downloaded your data. Uploaded files can be downloaded one by one from Journal > Input history.", true);
    } catch (err) {
      status(out, "Your data couldn't be exported. Try again.");
    }
  });

  const confirmInput = $("deleteConfirm");
  const deleteBtn = $("deleteAccount");
  confirmInput?.addEventListener("input", () => {
    deleteBtn.disabled = confirmInput.value.trim() !== "DELETE";
  });
  deleteBtn?.addEventListener("click", async () => {
    const out = $("deleteStatus");
    if (confirmInput.value.trim() !== "DELETE") return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting...";
    try {
      const { error } = await tpClient.functions.invoke("delete-account", { body: { confirm: "DELETE" } });
      if (error) {
        let msg = "Your account couldn't be deleted. Try again.";
        try {
          msg = (await error.context.json()).error || msg;
        } catch (x) {
          /* keep default */
        }
        throw new Error(msg);
      }
      await tpClient.auth.signOut().catch(() => {});
      window.location.href = "index.html";
    } catch (err) {
      status(out, err.message);
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete my account";
    }
  });
})();
