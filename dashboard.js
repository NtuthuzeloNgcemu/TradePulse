/* -----------------------------------------------
   TradePulse APP SHELL - shared script (all app pages)
   - Auth guard, profile menu, sidebar and mobile drawer
   - Shared helpers and data loading (window.TP)
   - "Add to TradePulse": upload, CSV review, AI reading, manual entry
   - Sources list with actions (Journal) and the Overview page
   Page scripts (journal.js, analytics-page.js, insights-page.js,
   playbook.js, account.js) build on window.TP.
----------------------------------------------- */

const body = document.body;
let currentUser = null;

/* =================================================================
   Plan
   What each plan allows. The database enforces the trade cap and the
   edge function enforces AI reading; this copy exists only so the
   interface can say so before someone runs into the wall.
   ================================================================= */
const PLANS = {
  free: { name: "Free", trades: 30, ai: false, insights: false },
  pro: { name: "Pro", trades: null, ai: true, insights: true },
  desk: { name: "Desk", trades: null, ai: true, insights: true },
};

// Starts as free: if the plan can't be read, the safe assumption is the
// one that promises least, never the one that promises most.
let currentPlan = { code: "free", ...PLANS.free, known: false };

async function loadPlan() {
  if (!currentUser) return currentPlan;
  const { data, error } = await tpClient.rpc("current_plan", { uid: currentUser.id });
  const code = !error && PLANS[data] ? data : "free";
  currentPlan = { code, ...PLANS[code], known: !error };
  return currentPlan;
}

/**
 * The free trade cap is enforced by a database trigger, so hitting it comes
 * back as a Postgres error. This turns it into a sentence worth reading.
 * Anything else is returned unchanged rather than dressed up.
 */
function tradeSaveMessage(error, attempted = 1) {
  const raw = String(error?.message || "");
  if (!raw.includes("trade_limit_reached")) return raw;
  const cap = PLANS.free.trades;
  return attempted > 1
    ? `The free plan holds ${cap} trades, and these would go past it. Nothing was added. Subscribe to Pro for unlimited trades, or delete some trades first.`
    : `The free plan holds ${cap} trades and yours is full. Subscribe to Pro for unlimited trades, or delete a trade to make room.`;
}

function renderPlanBadge() {
  const brand = document.querySelector(".sidebar .brand");
  if (!brand || brand.querySelector(".plan-badge")) return;
  const badge = document.createElement("span");
  badge.className = `plan-badge plan-badge-${currentPlan.code}`;
  badge.textContent = currentPlan.name;
  badge.title = currentPlan.code === "free" ? "Free plan" : `${currentPlan.name} subscription`;
  brand.appendChild(badge);
  body.dataset.plan = currentPlan.code;
}

/* =================================================================
   Shared helpers
   ================================================================= */

// Escapes text for both element content and attribute values.
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatResultR(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return { text: "-", cls: "" };
  const v = Number(value);
  return { text: `${v > 0 ? "+" : ""}${Math.round(v * 100) / 100}R`, cls: v > 0 ? "positive" : v < 0 ? "negative" : "" };
}

function formatDate(iso, withTime = false) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return withTime
    ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatRange(first, last) {
  if (!first) return null;
  const a = formatDate(first);
  const b = formatDate(last);
  return a === b ? a : `${a} to ${b}`;
}

function fileExtension(name) {
  return String(name || "").includes(".") ? String(name).split(".").pop().toLowerCase() : "";
}

const isCsvName = (name) => fileExtension(name) === "csv";
const AI_READABLE = ["pdf", "png", "jpg", "jpeg", "txt"];
const isAiReadable = (name) => AI_READABLE.includes(fileExtension(name));

// Small event bus: page scripts re-render when data changes
function emitDataChanged(kind) {
  TP.invalidate(kind);
  document.dispatchEvent(new CustomEvent("tp:data-changed", { detail: { kind } }));
}

let resolveReady;
const tpReady = new Promise((resolve) => (resolveReady = resolve));

/* ---------- Data loading (paged, so lists never stop at 1,000 rows) ---------- */
const TRADE_COLUMNS =
  "id, source_id, instrument, direction, session, setup, entry_price, exit_price, entry_time, exit_time, result_r, rule_score, emotion, notes, import_notes, created_at, updated_at";
const SOURCE_COLUMNS =
  "id, file_name, file_type, status, status_detail, storage_path, file_size, file_hash, created_at, processed_at, extracted_by, extracted_at";
const RULE_COLUMNS = "id, rule_text, status, origin, source_id, evidence, created_at, updated_at";

async function fetchAll(table, columns) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await tpClient
      .from(table)
      .select(columns)
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

const cache = new Map();
function cached(kind, loader) {
  if (!cache.has(kind)) {
    const p = loader().catch((err) => {
      cache.delete(kind);
      throw err;
    });
    cache.set(kind, p);
  }
  return cache.get(kind);
}

const TP = {
  get user() {
    return currentUser;
  },
  ready: tpReady,
  escapeHtml,
  plural,
  formatResultR,
  formatDate,
  formatRange,
  fileExtension,
  emitDataChanged,
  invalidate(kind) {
    if (!kind) cache.clear();
    else cache.delete(kind);
  },
  getTrades: () =>
    cached("trades", async () => {
      const rows = await fetchAll("trades", TRADE_COLUMNS);
      for (const t of rows) {
        for (const f of ["result_r", "entry_price", "exit_price"]) t[f] = t[f] === null ? null : Number(t[f]);
      }
      return rows;
    }),
  getSources: () => cached("sources", () => fetchAll("sources", SOURCE_COLUMNS)),
  getRules: () => cached("rules", () => fetchAll("playbook_rules", RULE_COLUMNS)),
  openUpload: () => openModal(document.activeElement),
  reviewSource: (id) => reviewSourceById(id),
  readWithAi: (id) => readWithAiById(id),
  createDialog,
  regionLoading: setRegionLoading,
  regionError: setRegionError,
  getPlan: () => cached("plan", loadPlan),
  plan: () => currentPlan,
};
window.TP = TP;

/* =================================================================
   Auth guard
   Every app page requires a real session. Content stays hidden
   (see dashboard.css .app-body) until this resolves.
   ================================================================= */
(async () => {
  let session = null;
  try {
    const result = await tpClient.auth.getSession();
    session = result.data.session;
  } catch (err) {
    window.location.href = "login.html";
    return;
  }
  if (!session) {
    window.location.href = "login.html";
    return;
  }

  body.classList.add("auth-ready");
  currentUser = session.user;
  resolveReady(currentUser);

  // The plan decides what the rest of the interface offers, so it is read
  // before anything that depends on it is drawn.
  await TP.getPlan();
  renderPlanBadge();

  renderSourcesSummary();
  renderOverview();

  try {
    const pb = document.getElementById("profileButton");
    const identityBlock = document.getElementById("profileIdentity");
    const identityName = document.getElementById("profileIdentityName");
    const identityEmail = document.getElementById("profileIdentityEmail");
    const { data: profile } = await tpClient.from("profiles").select("first_name, last_name").eq("id", session.user.id).single();
    const initial = (profile?.first_name?.trim() || session.user.email || "?").charAt(0).toUpperCase();
    if (pb) pb.textContent = initial;
    if (identityBlock && identityName && identityEmail) {
      const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ");
      identityName.textContent = fullName || "Your account";
      identityEmail.textContent = session.user.email;
      identityBlock.hidden = false;
    }
  } catch (err) {
    // Non-essential personalisation
  }
})();

// Signed out in another tab, or the session couldn't be refreshed
tpClient.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") window.location.href = "login.html";
});

document.getElementById("logoutLink")?.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await tpClient.auth.signOut();
  } finally {
    window.location.href = "index.html";
  }
});

/* =================================================================
   Profile menu
   ================================================================= */
const profileButton = document.getElementById("profileButton");
const profileMenu = document.getElementById("profileMenu");

function toggleProfile(force) {
  if (!profileMenu || !profileButton) return;
  const open = force ?? profileMenu.hidden;
  profileMenu.hidden = !open;
  profileButton.setAttribute("aria-expanded", String(open));
  if (open) profileMenu.querySelector("a")?.focus();
}

profileButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleProfile();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".profile-wrap") && profileMenu && !profileMenu.hidden) toggleProfile(false);
  if (body.classList.contains("sidebar-open") && !event.target.closest(".sidebar") && !event.target.closest("#mobileMenu")) {
    setDrawer(false);
  }
});

/* =================================================================
   Sidebar: collapse (desktop, remembered) and drawer (mobile)
   ================================================================= */
const sidebarToggle = document.getElementById("sidebarToggle");
const mobileMenu = document.getElementById("mobileMenu");
const SIDEBAR_KEY = "tp_sidebar_collapsed";

function setCollapsed(collapsed) {
  body.classList.toggle("sidebar-collapsed", collapsed);
  if (sidebarToggle) {
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    sidebarToggle.setAttribute("aria-label", label);
    sidebarToggle.setAttribute("title", label);
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  }
}

try {
  if (window.localStorage.getItem(SIDEBAR_KEY) === "1") setCollapsed(true);
} catch (err) {
  /* storage unavailable: default to expanded */
}

// Tooltips for the icon-only (collapsed) state
document.querySelectorAll(".sidebar .side-link").forEach((link) => {
  const label = link.querySelector("span:not(.side-icon)")?.textContent.trim();
  if (label && !link.title) link.title = label;
});

sidebarToggle?.addEventListener("click", () => {
  const collapsed = !body.classList.contains("sidebar-collapsed");
  setCollapsed(collapsed);
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch (err) {
    /* ignore */
  }
});

const drawer = window.TPInteractions?.attachDrawer({
  panel: document.getElementById("appSidebar"),
  button: mobileMenu,
  body,
}) ?? null;

function setDrawer(open) {
  if (drawer) return drawer.setOpen(open);
  body.classList.toggle("sidebar-open", open);
  mobileMenu?.setAttribute("aria-expanded", String(open));
  mobileMenu?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  if (open) document.querySelector(".sidebar .side-link")?.focus();
}

mobileMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
  setDrawer(!body.classList.contains("sidebar-open"));
});

// Following a link should leave the drawer behind
document.querySelectorAll(".sidebar .side-link").forEach((link) => {
  link.addEventListener("click", () => {
    if (body.classList.contains("sidebar-open")) body.classList.remove("sidebar-open");
  });
});

/* =================================================================
   Dialogs (upload modal + generic dialogs) with focus handling
   ================================================================= */
const ADD_BUTTON_SELECTOR =
  "#addButton, #emptyAddButton, #addButtonInline, #journalAdd, #journalEmptyAdd, #analyticsAdd, #insightsAdd, #playbookAdd, [data-open-upload]";
const modal = document.getElementById("uploadModal");
const dialog = modal?.querySelector(".dialog");
const closeModalButton = document.getElementById("closeModal");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const fileResult = document.getElementById("fileResult");

let modalTriggerEl = null;

function getFocusable(container) {
  return [
    ...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null);
}

let modalPresentation = null;

function openModal(trigger) {
  if (!modal || !dialog) return;
  if (!modal.hidden) return; // already up; don't restart the entrance
  modalTriggerEl = trigger ?? document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = "hidden";

  modalPresentation = window.TPInteractions?.presentOverlay({
    root: modal,
    surface: dialog,
    backdrop: modal.querySelector(".backdrop"),
    trigger: modalTriggerEl,
    onDismiss: finishCloseModal,
  }) ?? null;

  (getFocusable(dialog)[0] ?? dialog).focus();
}

function finishCloseModal() {
  if (!modal) return;
  modal.hidden = true;
  modalPresentation = null;
  document.body.style.overflow = "";
  modalTriggerEl?.focus();
  modalTriggerEl = null;
  resetModalState();
}

function closeModal() {
  if (!modal || modal.hidden) return;
  if (modalPresentation) modalPresentation.dismiss();
  else finishCloseModal();
}

function resetModalState() {
  if (fileResult) {
    fileResult.hidden = true;
    fileResult.innerHTML = "";
  }
  const reviewSection = document.getElementById("reviewSection");
  if (reviewSection) reviewSection.hidden = true;
  pendingReview = null;
  otherFilesHtml = "";

  const manualForm = document.getElementById("manualEntryForm");
  const manualToggle = document.getElementById("manualEntryToggle");
  if (manualForm) {
    manualForm.hidden = true;
    manualForm.reset();
  }
  if (manualToggle) manualToggle.hidden = false;
  if (dropZone) dropZone.hidden = false;
  const manualError = document.getElementById("manualEntryError");
  if (manualError) manualError.textContent = "";
  const manualSubmitBtn = document.getElementById("manualEntrySubmit");
  if (manualSubmitBtn) {
    manualSubmitBtn.disabled = false;
    manualSubmitBtn.textContent = "Add trade";
  }
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest(ADD_BUTTON_SELECTOR);
  if (trigger) openModal(trigger);
});
closeModalButton?.addEventListener("click", closeModal);
modal?.addEventListener("click", (event) => {
  if (event.target.dataset.close === "true") closeModal();
});

/**
 * Generic dialog for confirmations and editors.
 * Returns { root, dialog, close }. onClose runs once when it closes.
 */
const openDialogs = [];
function createDialog({ title, html, onClose, wide = false }) {
  const trigger = document.activeElement;
  const root = document.createElement("div");
  root.className = "upload-modal tp-dialog";
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  root.innerHTML = `
    <div class="backdrop" data-dialog-close="true"></div>
    <div class="dialog${wide ? " dialog-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <div class="sheet-grip" aria-hidden="true"></div>
      <button class="close" type="button" data-dialog-close="true" aria-label="Close">&times;</button>
      <h2 id="${titleId}" class="dialog-title">${escapeHtml(title)}</h2>
      <div class="dialog-body">${html}</div>
    </div>`;
  document.body.appendChild(root);
  document.body.style.overflow = "hidden";
  const dlg = root.querySelector(".dialog");
  let closed = false;
  const teardown = () => {
    root.remove();
    openDialogs.splice(openDialogs.indexOf(entry), 1);
    if (!openDialogs.length && (!modal || modal.hidden)) document.body.style.overflow = "";
    trigger?.focus?.();
    onClose?.();
  };
  const presentation = window.TPInteractions?.presentOverlay({
    root,
    surface: dlg,
    backdrop: root.querySelector(".backdrop"),
    trigger,
    onDismiss: teardown,
  }) ?? null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (presentation) presentation.dismiss();
    else teardown();
  };
  const entry = { root, dialog: dlg, close };
  openDialogs.push(entry);
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-dialog-close]")) close();
  });
  (getFocusable(dlg).find((el) => !el.matches(".close")) ?? dlg).focus();
  return entry;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (openDialogs.length) return openDialogs[openDialogs.length - 1].close();
    if (profileMenu && !profileMenu.hidden) {
      toggleProfile(false);
      return profileButton?.focus();
    }
    if (modal && !modal.hidden) return closeModal();
    if (body.classList.contains("sidebar-open")) {
      setDrawer(false);
      return mobileMenu?.focus();
    }
    return;
  }

  if (event.key === "Tab") {
    const top = openDialogs.length ? openDialogs[openDialogs.length - 1].dialog : modal && !modal.hidden ? dialog : null;
    if (!top) return;
    const focusable = getFocusable(top);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

/* =================================================================
   Upload
   ================================================================= */
dropZone?.addEventListener("click", () => fileInput?.click());
dropZone?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput?.click();
  }
});
["dragenter", "dragover"].forEach((type) =>
  dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }),
);
["dragleave", "drop"].forEach((type) =>
  dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  }),
);
dropZone?.addEventListener("drop", (event) => showFiles([...event.dataTransfer.files]));
fileInput?.addEventListener("change", () => {
  showFiles([...fileInput.files]);
  fileInput.value = "";
});

// Matches the trading-sources bucket (supabase/migrations): 25 MB and these types
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = {
  csv: "text/csv",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

async function sha256Hex(file) {
  try {
    if (!window.crypto?.subtle) return null;
    const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (err) {
    return null;
  }
}

async function uploadFile(file) {
  if (!currentUser) return { success: false, fileName: file.name, error: "Not signed in." };

  const ext = fileExtension(file.name);
  if (!CONTENT_TYPES[ext]) return { success: false, fileName: file.name, error: "This file type isn't accepted." };
  if (file.size > MAX_UPLOAD_BYTES) return { success: false, fileName: file.name, error: "Files must be 25 MB or smaller." };
  if (file.size === 0) return { success: false, fileName: file.name, error: "This file is empty." };

  try {
    const hash = await sha256Hex(file);
    if (hash) {
      const { data: same } = await tpClient
        .from("sources")
        .select("id, file_name, created_at, status")
        .eq("user_id", currentUser.id)
        .eq("file_hash", hash)
        .limit(1);
      if (same && same.length) {
        return { success: false, duplicateOf: same[0], fileName: file.name };
      }
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const storagePath = `${currentUser.id}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await tpClient.storage
      .from("trading-sources")
      .upload(storagePath, file, { contentType: CONTENT_TYPES[ext], upsert: false });
    if (uploadError) return { success: false, fileName: file.name, error: uploadError.message };

    const { data: inserted, error: insertError } = await tpClient
      .from("sources")
      .insert({
        user_id: currentUser.id,
        file_name: file.name,
        file_type: ext,
        storage_path: storagePath,
        status: "uploaded",
        file_size: file.size,
        file_hash: hash,
        status_detail: isCsvName(file.name) || isAiReadable(file.name) ? null : "Stored, not processed",
      })
      .select("id")
      .single();

    if (insertError) {
      await tpClient.storage.from("trading-sources").remove([storagePath]).catch(() => {});
      return { success: false, fileName: file.name, error: insertError.message };
    }
    return { success: true, fileName: file.name, sourceId: inserted.id, file };
  } catch (err) {
    return { success: false, fileName: file.name, error: "Couldn't reach TradePulse." };
  }
}

let isUploading = false;
let otherFilesHtml = "";

function showFileMessage(html) {
  if (!fileResult) return;
  fileResult.hidden = false;
  fileResult.innerHTML = html + otherFilesHtml;
}

async function showFiles(files) {
  if (!files.length || !fileResult) return;
  if (isUploading) {
    fileResult.hidden = false;
    fileResult.innerHTML = `<p class="file-result-error">Still saving your last upload. Try again in a moment.</p>`;
    return;
  }
  isUploading = true;
  const reviewSection = document.getElementById("reviewSection");
  if (reviewSection) reviewSection.hidden = true;
  pendingReview = null;
  otherFilesHtml = "";
  fileResult.hidden = false;
  fileResult.innerHTML = `<strong>Saving ${plural(files.length, "file", "files")}...</strong>`;

  try {
    const results = await Promise.all(files.map(uploadFile));
    const succeeded = results.filter((r) => r.success);
    const duplicates = results.filter((r) => r.duplicateOf);
    const failed = results.filter((r) => !r.success && !r.duplicateOf);
    const csvs = succeeded.filter((r) => isCsvName(r.fileName));
    const aiFiles = succeeded.filter((r) => isAiReadable(r.fileName));
    const stored = succeeded.filter((r) => !isCsvName(r.fileName) && !isAiReadable(r.fileName));
    const reviewCsv = csvs[0];
    const extraCsvs = csvs.slice(1);

    let html = "";
    if (aiFiles.length) {
      html += `<div class="file-block"><strong>Saved. Ready to read with AI</strong><p>${aiFiles.map((r) => escapeHtml(r.fileName)).join(", ")}</p>`;
      html += aiFiles.length === 1 && !reviewCsv
        ? `<p>TradePulse can read this file with AI and show you what it finds before anything is added.</p><button class="button button-ink button-small" type="button" data-read-ai="${escapeHtml(aiFiles[0].sourceId)}">Read with AI</button>`
        : `<p>Use "Read with AI" next to each file in Journal &gt; Input history.</p>`;
      html += `</div>`;
    }
    if (stored.length) {
      html += `<div class="file-block"><strong>Stored, not processed</strong><p>${stored.map((r) => escapeHtml(r.fileName)).join(", ")}</p>`;
      html += `<p>TradePulse can't read this file type yet. For spreadsheets, export them as CSV to import the trades. No trades, analytics or insights were created from it.</p></div>`;
    }
    if (extraCsvs.length) {
      html += `<p>Only one CSV can be reviewed at a time. ${extraCsvs.map((r) => escapeHtml(r.fileName)).join(", ")} ${
        extraCsvs.length === 1 ? "was" : "were"
      } saved. Use "Review" in Journal &gt; Input history to import ${extraCsvs.length === 1 ? "it" : "them"}.</p>`;
    }
    if (duplicates.length) {
      html += duplicates
        .map(
          (d) =>
            `<p class="file-result-warning">${escapeHtml(d.fileName)} is already in your workspace (uploaded ${escapeHtml(
              formatDate(d.duplicateOf.created_at),
            )} as ${escapeHtml(d.duplicateOf.file_name)}), so it wasn't uploaded again.</p>`,
        )
        .join("");
    }
    if (failed.length) {
      html += `<p class="file-result-error">${failed.length} failed to save: ${failed
        .map((r) => `${escapeHtml(r.fileName)} (${escapeHtml(r.error)})`)
        .join("; ")}</p>`;
    }

    otherFilesHtml = html;
    fileResult.innerHTML = reviewCsv ? `<strong>${escapeHtml(reviewCsv.fileName)} saved. Checking its rows...</strong>${html}` : html;
    if (succeeded.length) emitDataChanged("sources");
    if (reviewCsv) await reviewCsvFile(reviewCsv.file, reviewCsv.sourceId, reviewCsv.fileName);
  } catch (err) {
    fileResult.innerHTML = `<p class="file-result-error">Couldn't reach TradePulse right now. Check your connection and try again.</p>`;
  } finally {
    isUploading = false;
  }
}

/* =================================================================
   Review: CSV rows and AI-extracted rows share one screen.
   Parsing rules: trade-parser.js. Nothing is saved until confirm.
   ================================================================= */
let pendingReview = null;

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function markSource(sourceId, status, detail) {
  if (!sourceId) return { error: null };
  try {
    const update = { status };
    if (detail !== undefined) update.status_detail = detail;
    if (status === "processed" || status === "failed") update.processed_at = new Date().toISOString();
    return await tpClient.from("sources").update(update).eq("id", sourceId);
  } catch (err) {
    return { error: err };
  }
}

async function withDuplicateCheck(analysis) {
  try {
    const existing = await TP.getTrades();
    return window.TradeParser.markDuplicates(analysis, existing);
  } catch (err) {
    return { ...analysis, duplicates: 0, notes: [...(analysis.notes || []), "Couldn't check for duplicates because your trades didn't load."] };
  }
}

async function reviewCsvFile(file, sourceId, fileName) {
  let analysis;
  try {
    if (!window.Papa || !window.TradeParser) throw new Error("Parser not loaded");
    const text = await readFileAsText(file);
    analysis = window.TradeParser.analyseCsv(text, window.Papa);
  } catch (err) {
    showFileMessage(`<strong>${escapeHtml(fileName)} is saved, but couldn't be read.</strong><p>Nothing was added to your journal.</p>`);
    return;
  }

  if (!analysis.ok) {
    await markSource(sourceId, "failed", analysis.reason);
    emitDataChanged("sources");
    showFileMessage(
      `<strong>${escapeHtml(fileName)} couldn't be imported.</strong><p>${escapeHtml(analysis.reason)}</p><p>The file is still stored. Nothing was added to your journal.</p>`,
    );
    return;
  }

  analysis = await withDuplicateCheck(analysis);
  pendingReview = { ...analysis, sourceId, fileName, origin: "csv" };
  showFileMessage(`<strong>${escapeHtml(fileName)} saved.</strong><p>Check the rows below before anything is added to your journal.</p>`);
  renderReviewPreview(pendingReview);
}

const AI_HEADERS = ["instrument", "direction", "entry_time", "exit_time", "entry_price", "exit_price", "result_r", "session", "setup", "notes"];

async function reviewExtraction(extraction, sourceId, fileName) {
  const rows = (extraction.trades || []).map((t) => Object.fromEntries(AI_HEADERS.map((h) => [h, t[h] ?? ""])));
  const parsed = window.TradeParser.parseTradesFromRows(rows, AI_HEADERS);
  // Carry the AI's evidence quote with each row so the user can check it
  const attach = (list) => list.map((r) => ({ ...r, evidence: extraction.trades[r.rowNumber - 2]?.evidence || null }));
  const notes = [`Found by AI (${extraction.model || "Groq"}) in ${fileName}. Check every row against the original before adding it.`];
  if (extraction.truncated) notes.push(`Only the first ${extraction.pages_read} of ${extraction.pages_total} pages were read. Split the file to read the rest.`);
  if (extraction.more_not_listed) notes.push("The file has more items than the AI could list in one go. Split the file to read the rest.");
  if (parsed.assumedLocalTime) notes.push("Some times had no time zone, so they were read in your device's time zone.");
  let analysis = { ok: true, totalRows: rows.length, notes, ...parsed, ready: attach(parsed.ready), review: attach(parsed.review), skipped: attach(parsed.skipped) };
  analysis = await withDuplicateCheck(analysis);
  pendingReview = { ...analysis, sourceId, fileName, origin: "ai", model: extraction.model };
  renderReviewPreview(pendingReview);
}

function renderRowList(items, limit) {
  const rows = items
    .slice(0, limit)
    .map((item) => {
      const name = item.instrument || item.trade?.instrument;
      return `
        <div class="review-row review-row-issue">
          <span class="review-col-rownum">${pendingReview?.origin === "ai" ? `#${item.rowNumber - 1}` : `Row ${item.rowNumber}`}</span>
          <span class="review-col-reason">${name ? `<strong>${escapeHtml(name)}</strong> ` : ""}${item.reasons.map(escapeHtml).join("; ")}${
            item.evidence ? `<span class="review-evidence">Source text: "${escapeHtml(item.evidence)}"</span>` : ""
          }</span>
        </div>`;
    })
    .join("");
  const more = items.length > limit ? `<div class="review-row"><span class="review-col-reason">+ ${items.length - limit} more</span></div>` : "";
  return rows + more;
}

function selectedReviewRows() {
  if (!pendingReview) return [];
  const include = document.getElementById("reviewIncludeFlagged")?.checked;
  return [...pendingReview.ready, ...(include ? pendingReview.review : [])];
}

function updateConfirmButton() {
  const confirmBtn = document.getElementById("reviewConfirm");
  if (!confirmBtn) return;
  const count = selectedReviewRows().length;
  confirmBtn.hidden = count === 0;
  confirmBtn.disabled = false;
  confirmBtn.textContent = `Add ${plural(count, "trade", "trades")} to Journal`;
}

function renderReviewPreview(analysis) {
  const summary = document.getElementById("reviewSummary");
  const preview = document.getElementById("reviewPreview");
  const section = document.getElementById("reviewSection");
  if (!summary || !preview || !section) return;
  const { ready, review, skipped, totalRows, notes, duplicates } = analysis;
  const unit = analysis.origin === "ai" ? ["item", "items"] : ["row", "rows"];

  const parts = [`<strong>${ready.length} of ${plural(totalRows, ...unit)}</strong> ${ready.length === 1 ? "is" : "are"} ready to import.`];
  if (review.length) parts.push(`${plural(review.length, `${unit[0]} needs`, `${unit[1]} need`)} review and won't be added unless you choose to.`);
  if (duplicates) parts.push(`${plural(duplicates, "looks", "look")} like ${duplicates === 1 ? "a duplicate" : "duplicates"}.`);
  if (skipped.length) parts.push(`${plural(skipped.length, unit[0], unit[1])} can't be imported.`);
  summary.innerHTML = parts.join(" ") + (notes || []).map((n) => `<span class="review-note">${escapeHtml(n)}</span>`).join("");

  let html = "";
  if (ready.length) {
    const rows = ready
      .slice(0, 12)
      .map(({ rowNumber, trade, evidence }) => {
        const r = formatResultR(trade.result_r);
        return `
          <div class="review-row">
            <span class="review-col-rownum">${analysis.origin === "ai" ? rowNumber - 1 : rowNumber}</span>
            <span class="review-col-instrument">${escapeHtml(trade.instrument)}${evidence ? `<span class="review-evidence">"${escapeHtml(evidence)}"</span>` : ""}</span>
            <span class="review-col-setup">${escapeHtml(formatDate(trade.entry_time))}</span>
            <span class="review-col-setup">${escapeHtml(trade.direction || "-")}</span>
            <span class="review-col-result ${r.cls}">${r.text}</span>
          </div>`;
      })
      .join("");
    const more = ready.length > 12 ? `<div class="review-row"><span class="review-col-instrument">+ ${ready.length - 12} more</span></div>` : "";
    html += `
      <div class="review-group-title">Ready to import</div>
      <div class="review-row review-row-head">
        <span class="review-col-rownum">${analysis.origin === "ai" ? "#" : "Row"}</span>
        <span class="review-col-instrument">Instrument</span>
        <span class="review-col-setup">Date</span>
        <span class="review-col-setup">Direction</span>
        <span class="review-col-result">Result</span>
      </div>
      ${rows}${more}`;
  }
  if (review.length) html += `<div class="review-group-title">Needs review</div>${renderRowList(review, 30)}`;
  if (skipped.length) html += `<div class="review-group-title">Can't be imported</div>${renderRowList(skipped, 30)}`;
  preview.innerHTML = html;

  const includeWrap = document.getElementById("reviewIncludeWrap");
  if (includeWrap) {
    includeWrap.hidden = !review.length;
    includeWrap.innerHTML = review.length
      ? `<label class="review-include"><input type="checkbox" id="reviewIncludeFlagged" /> Also add the ${plural(
          review.length,
          `${unit[0]} that needs`,
          `${unit[1]} that need`,
        )} review. Unclear values will be left blank, and duplicates will be added as they are.</label>`
      : "";
  }

  updateConfirmButton();
  section.hidden = false;
}

document.addEventListener("change", (event) => {
  if (event.target.id === "reviewIncludeFlagged") updateConfirmButton();
});

document.getElementById("reviewCancel")?.addEventListener("click", async () => {
  const section = document.getElementById("reviewSection");
  if (section) section.hidden = true;
  if (pendingReview) {
    showFileMessage(`<strong>${escapeHtml(pendingReview.fileName)} was not imported.</strong><p>The file is still stored. You can review it later from Journal &gt; Input history. Nothing was added to your journal.</p>`);
  }
  pendingReview = null;
});

const FIELD_NAMES = { direction: "direction", entry_price: "entry price", exit_price: "exit price", entry_time: "entry time", exit_time: "exit time", result_r: "result (R)" };

function importNote(review, row) {
  const when = new Date().toISOString().slice(0, 10);
  const base =
    review.origin === "ai"
      ? `Found by AI (${review.model || "Groq"}) in ${review.fileName}, item ${row.rowNumber - 1}; confirmed by you on ${when}.`
      : `Imported from ${review.fileName}, row ${row.rowNumber}; confirmed by you on ${when}.`;
  const blank = (row.fields || []).map((f) => FIELD_NAMES[f] || f);
  const extra = [];
  if (blank.length) extra.push(`Left blank because unclear: ${blank.join(", ")}.`);
  if (row.duplicate) extra.push("Added although it looked like a duplicate.");
  if (row.evidence) extra.push(`Source text: "${row.evidence}"`);
  return [base, ...extra].join(" ").slice(0, 1000);
}

document.getElementById("reviewConfirm")?.addEventListener("click", async () => {
  const btn = document.getElementById("reviewConfirm");
  const summary = document.getElementById("reviewSummary");
  const selected = selectedReviewRows();
  if (!btn || !currentUser || !pendingReview || !selected.length) return;

  const review = pendingReview;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Adding...";

  try {
    const rows = selected.map((row) => ({
      ...row.trade,
      user_id: currentUser.id,
      source_id: review.sourceId,
      import_notes: importNote(review, row),
    }));
    const { error: insertError } = await tpClient.from("trades").insert(rows);
    if (insertError) {
      const capped = String(insertError.message || "").includes("trade_limit_reached");
      const text = capped
        ? tradeSaveMessage(insertError, rows.length)
        : `Couldn't save trades: ${insertError.message}. Nothing was added.`;
      if (summary) {
        summary.innerHTML = `<span class="file-result-error">${escapeHtml(text)}</span>${
          capped ? ` <a href="account.html#billing">See Pro</a>` : ""
        }`;
      }
      btn.disabled = false;
      btn.textContent = originalLabel;
      return;
    }

    const detail = review.origin === "ai" ? `Read by AI: ${plural(rows.length, "trade", "trades")} added after your review.` : `${plural(rows.length, "trade", "trades")} imported.`;
    const { error: statusError } = await markSource(review.sourceId, "processed", detail);

    const section = document.getElementById("reviewSection");
    if (section) section.hidden = true;
    pendingReview = null;

    window.TPMotion?.tap(8); // one short confirmation, only on a real commit
    showFileMessage(
      `<strong>Added ${plural(rows.length, "trade", "trades")} to your journal from ${escapeHtml(review.fileName)}.</strong>${
        statusError
          ? `<p class="file-result-error">The trades were saved, but the file's status couldn't be updated, so it may still show as not imported. Don't import it again, or the trades will be added twice.</p>`
          : ""
      }`,
    );
    emitDataChanged("trades");
    emitDataChanged("sources");
  } catch (err) {
    if (summary) summary.innerHTML = `<span class="file-result-error">Couldn't reach TradePulse. Check your connection and try again.</span>`;
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

/* =================================================================
   Source actions: review later, read with AI, download, delete
   ================================================================= */
async function loadSource(id, withExtraction = false) {
  const { data, error } = await tpClient
    .from("sources")
    .select(SOURCE_COLUMNS + (withExtraction ? ", extraction" : ""))
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function reviewSourceById(id) {
  openModal(document.activeElement);
  if (dropZone) dropZone.hidden = true;
  document.getElementById("manualEntryToggle")?.setAttribute("hidden", "");
  showFileMessage(`<strong>Opening the file...</strong>`);
  try {
    const source = await loadSource(id, true);
    if (source.extraction && (source.extraction.trades || []).length) {
      showFileMessage(`<strong>${escapeHtml(source.file_name)}</strong><p>${escapeHtml(source.extraction.summary || "Read by AI.")}</p>`);
      return reviewExtraction(source.extraction, source.id, source.file_name);
    }
    if (isCsvName(source.file_name)) {
      const { data: blob, error } = await tpClient.storage.from("trading-sources").download(source.storage_path);
      if (error || !blob) throw error || new Error("Download failed");
      return reviewCsvFile(new File([blob], source.file_name, { type: "text/csv" }), source.id, source.file_name);
    }
    showFileMessage(`<strong>There's nothing to review in ${escapeHtml(source.file_name)} yet.</strong>`);
  } catch (err) {
    showFileMessage(`<p class="file-result-error">The file couldn't be opened. Try again.</p>`);
  }
}

async function functionErrorMessage(error, fallback) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch (e) {
    /* ignore */
  }
  return fallback;
}

function readWithAiById(id) {
  if (!modal || modal.hidden) openModal(document.activeElement);
  if (dropZone) dropZone.hidden = true;
  document.getElementById("manualEntryToggle")?.setAttribute("hidden", "");
  otherFilesHtml = "";

  // The edge function refuses this on a free account, so there is no point
  // sending the request. The answer is the same either way.
  if (!currentPlan.ai) {
    showFileMessage(`
      <strong>Reading files with AI is part of Pro.</strong>
      <p>Your file stays where it is and nothing is sent anywhere. On the free plan you can still import CSV files and enter trades by hand.</p>
      <div class="review-actions review-actions-start">
        <button class="button button-paper button-small" type="button" data-ai-cancel>Close</button>
        <a class="button button-ink button-small" href="account.html#billing">See Pro</a>
      </div>`);
    return;
  }

  loadSource(id)
    .then((source) => {
      showFileMessage(`
        <strong>Read ${escapeHtml(source.file_name)} with AI?</strong>
        <p>TradePulse sends this file to Groq, an AI service in the United States, to find trades and any trading rules you've written down. Groq doesn't keep it by default. Nothing is added to your journal or playbook until you review it.</p>
        <div class="review-actions review-actions-start">
          <button class="button button-paper button-small" type="button" data-ai-cancel>Not now</button>
          <button class="button button-ink button-small" type="button" data-ai-confirm="${escapeHtml(source.id)}">Read with AI</button>
        </div>`);
    })
    .catch(() => showFileMessage(`<p class="file-result-error">The file couldn't be found.</p>`));
}

async function runAiRead(id) {
  showFileMessage(`<strong role="status">Reading the file with AI. This usually takes under a minute.</strong><p>Stay on this page until it finishes.</p>`);
  try {
    const { data, error } = await tpClient.functions.invoke("process-source", { body: { source_id: id } });
    emitDataChanged("sources");
    if (error) {
      const msg = await functionErrorMessage(error, "The file couldn't be read. Try again later.");
      showFileMessage(`<p class="file-result-error">${escapeHtml(msg)}</p>`);
      return;
    }
    if (data.rules_suggested) emitDataChanged("rules");
    const ruleNote = data.rules_suggested
      ? `<p>${plural(data.rules_suggested, "suggested rule was", "suggested rules were")} added to <a href="playbook.html">Playbook</a> for you to accept or reject.</p>`
      : "";
    if (data.trades) {
      const source = await loadSource(id);
      showFileMessage(`<strong>${escapeHtml(data.detail)}</strong>${ruleNote}`);
      return reviewExtraction(data.extraction, id, source.file_name);
    }
    showFileMessage(`<strong>${escapeHtml(data.detail)}</strong>${ruleNote}`);
  } catch (err) {
    showFileMessage(`<p class="file-result-error">Couldn't reach TradePulse. Check your connection and try again.</p>`);
  }
}

document.addEventListener("click", (event) => {
  const readBtn = event.target.closest("[data-read-ai]");
  if (readBtn) return readWithAiById(readBtn.dataset.readAi);
  const confirmBtn = event.target.closest("[data-ai-confirm]");
  if (confirmBtn) return runAiRead(confirmBtn.dataset.aiConfirm);
  if (event.target.closest("[data-ai-cancel]")) return closeModal();
  const reviewBtn = event.target.closest("[data-review-source]");
  if (reviewBtn) return reviewSourceById(reviewBtn.dataset.reviewSource);
  const dlBtn = event.target.closest("[data-download-source]");
  if (dlBtn) return downloadSource(dlBtn.dataset.downloadSource);
  const delBtn = event.target.closest("[data-delete-source]");
  if (delBtn) return confirmDeleteSource(delBtn.dataset.deleteSource);
});

async function downloadSource(id) {
  try {
    const source = await loadSource(id);
    const { data, error } = await tpClient.storage.from("trading-sources").createSignedUrl(source.storage_path, 60, { download: source.file_name });
    if (error) throw error;
    window.open(data.signedUrl, "_blank", "noopener");
  } catch (err) {
    createDialog({ title: "Download failed", html: `<p class="card-copy">The file couldn't be downloaded. Try again.</p>` });
  }
}

async function confirmDeleteSource(id) {
  let source;
  let tradeCount = 0;
  try {
    source = await loadSource(id);
    const { count } = await tpClient.from("trades").select("id", { count: "exact", head: true }).eq("source_id", id);
    tradeCount = count || 0;
  } catch (err) {
    return createDialog({ title: "Couldn't load this file", html: `<p class="card-copy">Try again in a moment.</p>` });
  }

  const d = createDialog({
    title: `Delete ${source.file_name}?`,
    html: `
      <p class="card-copy">The file is removed from your workspace and storage. This can't be undone.</p>
      ${
        tradeCount
          ? `<p class="card-copy">${plural(tradeCount, "trade was", "trades were")} imported from it.</p>
             <label class="review-include"><input type="checkbox" id="deleteSourceTrades" /> Also delete ${tradeCount === 1 ? "that trade" : `those ${tradeCount} trades`}</label>`
          : ""
      }
      <p class="field-error" id="deleteSourceError" role="alert"></p>
      <div class="review-actions">
        <button class="button button-paper" type="button" data-dialog-close="true">Cancel</button>
        <button class="button button-danger" type="button" id="deleteSourceConfirm">Delete file</button>
      </div>`,
  });

  d.root.querySelector("#deleteSourceConfirm").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const errEl = d.root.querySelector("#deleteSourceError");
    const alsoTrades = d.root.querySelector("#deleteSourceTrades")?.checked;
    btn.disabled = true;
    btn.textContent = "Deleting...";
    try {
      if (alsoTrades) {
        const { error } = await tpClient.from("trades").delete().eq("source_id", id);
        if (error) throw error;
      }
      // Suggested rules from this file go with it; confirmed rules stay
      await tpClient.from("playbook_rules").delete().eq("source_id", id).eq("status", "suggested");
      if (source.storage_path) {
        const { error } = await tpClient.storage.from("trading-sources").remove([source.storage_path]);
        if (error) throw error;
      }
      const { error } = await tpClient.from("sources").delete().eq("id", id);
      if (error) throw error;
      d.close();
      emitDataChanged("sources");
      emitDataChanged("rules");
      if (alsoTrades) emitDataChanged("trades");
    } catch (err) {
      errEl.textContent = "The file couldn't be deleted. Try again.";
      btn.disabled = false;
      btn.textContent = "Delete file";
    }
  });
}

/* =================================================================
   Manual trade entry
   ================================================================= */
document.getElementById("showManualEntry")?.addEventListener("click", () => {
  const manualForm = document.getElementById("manualEntryForm");
  const manualToggle = document.getElementById("manualEntryToggle");
  if (dropZone) dropZone.hidden = true;
  if (manualToggle) manualToggle.hidden = true;
  if (fileResult) fileResult.hidden = true;
  if (manualForm) {
    manualForm.hidden = false;
    document.getElementById("tradeInstrument")?.focus();
  }
});

document.getElementById("manualEntryCancel")?.addEventListener("click", () => {
  resetModalState();
});

function localInputToIso(id) {
  const raw = document.getElementById(id)?.value;
  if (!raw) return null;
  const d = new Date(raw); // datetime-local is read in the device's time zone
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

document.getElementById("manualEntryForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return;

  const instrument = document.getElementById("tradeInstrument");
  const resultR = document.getElementById("tradeResultR");
  const manualError = document.getElementById("manualEntryError");
  const submitBtn = document.getElementById("manualEntrySubmit");
  if (manualError) manualError.textContent = "";

  if (!instrument.value.trim()) {
    manualError.textContent = "Enter an instrument.";
    return instrument.focus();
  }
  if (resultR.value === "" || Number.isNaN(Number(resultR.value))) {
    manualError.textContent = "Enter a result in R.";
    return resultR.focus();
  }
  const entryTime = localInputToIso("tradeEntryTime");
  const exitTime = localInputToIso("tradeExitTime");
  if (entryTime && exitTime && exitTime < entryTime) {
    manualError.textContent = "The exit time is before the entry time.";
    return document.getElementById("tradeExitTime")?.focus();
  }

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Adding...";
  const getValue = (id) => document.getElementById(id)?.value.trim() || null;
  const getNumber = (id) => {
    const raw = document.getElementById(id)?.value;
    return raw === "" || raw === undefined ? null : Number(raw);
  };

  try {
    const { error } = await tpClient.from("trades").insert({
      user_id: currentUser.id,
      source_id: null,
      instrument: instrument.value.trim(),
      direction: getValue("tradeDirection"),
      session: getValue("tradeSession"),
      setup: getValue("tradeSetup"),
      entry_price: getNumber("tradeEntryPrice"),
      exit_price: getNumber("tradeExitPrice"),
      entry_time: entryTime,
      exit_time: exitTime,
      result_r: getNumber("tradeResultR"),
      rule_score: getValue("tradeRuleScore"),
      emotion: getValue("tradeEmotion"),
      notes: getValue("tradeNotes"),
    });
    if (error) {
      manualError.textContent = tradeSaveMessage(error);
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      return;
    }
    closeModal();
    emitDataChanged("trades");
  } catch (err) {
    manualError.textContent = "Couldn't reach TradePulse. Check your connection and try again.";
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

/* =================================================================
   Loading / error states for page regions
   ================================================================= */
const regionTemplates = new Map();
function rememberTemplate(el) {
  if (el && !regionTemplates.has(el)) regionTemplates.set(el, el.innerHTML);
}
function restoreTemplate(el) {
  if (el && regionTemplates.has(el)) el.innerHTML = regionTemplates.get(el);
}
function setRegionLoading(el, message) {
  if (!el) return;
  rememberTemplate(el);
  el.setAttribute("aria-busy", "true");
  el.innerHTML = `<p class="card-copy is-loading">${escapeHtml(message)}</p>`;
}
function setRegionError(el, message, retryName) {
  if (!el) return;
  rememberTemplate(el);
  el.removeAttribute("aria-busy");
  el.innerHTML = `
    <h2 class="card-title">${escapeHtml(message)}</h2>
    <p class="card-copy">This is a connection or server problem. It doesn't mean your workspace is empty.</p>
    <button class="link-button" type="button" data-retry="${escapeHtml(retryName)}">Try again</button>`;
}
TP.restoreTemplate = restoreTemplate;
TP.rememberTemplate = rememberTemplate;

function setStat(valueEl, detailEl, value, detail) {
  if (valueEl) valueEl.textContent = value;
  if (detailEl) detailEl.textContent = detail;
}
TP.setStat = setStat;

document.addEventListener("click", (event) => {
  const retry = event.target.closest("[data-retry]");
  if (!retry) return;
  TP.invalidate(retry.dataset.retry);
  document.dispatchEvent(new CustomEvent("tp:data-changed", { detail: { kind: retry.dataset.retry } }));
});

/* =================================================================
   Sources: labels, Journal input history (with actions), review card
   ================================================================= */
function sourceStatusLabel(source) {
  switch (source.status) {
    case "processed": {
      const detail = source.status_detail || "";
      if (source.extracted_by && /No trades/.test(detail)) return { label: "Nothing found", cls: "stored" };
      if (source.extracted_by && /suggested rule/.test(detail) && !/trade/.test(detail)) return { label: "Rules suggested", cls: "processed" };
      return { label: "Imported", cls: "processed" };
    }
    case "failed":
      return { label: "Couldn't import", cls: "failed" };
    case "needs_review":
      return { label: "Needs review", cls: "needs_review" };
    case "processing":
      return { label: "Reading", cls: "processing" };
    default:
      if (isCsvName(source.file_name)) return { label: "Not imported", cls: "pending" };
      if (isAiReadable(source.file_name)) return { label: "Not read yet", cls: "pending" };
      return { label: "Stored, not processed", cls: "stored" };
  }
}
TP.sourceStatusLabel = sourceStatusLabel;

function sourceActions(s) {
  const a = [];
  const ext = fileExtension(s.file_name);
  if (s.status === "needs_review" || (ext === "csv" && s.status === "uploaded")) a.push(`<button class="link-button" type="button" data-review-source="${escapeHtml(s.id)}">Review</button>`);
  if (AI_READABLE.includes(ext) && (s.status === "uploaded" || (s.status === "failed" && !s.extracted_by))) {
    a.push(`<button class="link-button" type="button" data-read-ai="${escapeHtml(s.id)}">Read with AI</button>`);
  }
  a.push(`<button class="link-button" type="button" data-download-source="${escapeHtml(s.id)}">Download</button>`);
  a.push(`<button class="link-button link-danger" type="button" data-delete-source="${escapeHtml(s.id)}">Delete</button>`);
  return a.join("");
}

async function renderSourcesSummary() {
  if (!currentUser) return;
  const historyContent = document.getElementById("inputHistoryContent");
  const reviewCard = document.getElementById("reviewCardContent");
  if (!historyContent && !reviewCard) return;

  setRegionLoading(historyContent, "Loading your sources.");
  setRegionLoading(reviewCard, "Checking what needs attention.");

  let sources;
  try {
    sources = await TP.getSources();
  } catch (err) {
    setRegionError(historyContent, "Your sources couldn't be loaded.", "sources");
    setRegionError(reviewCard, "Review status couldn't be loaded.", "sources");
    return;
  }
  historyContent?.removeAttribute("aria-busy");
  reviewCard?.removeAttribute("aria-busy");

  if (historyContent) {
    if (!sources.length) restoreTemplate(historyContent);
    else {
      const rows = sources
        .map((s) => {
          const { label, cls } = sourceStatusLabel(s);
          return `
          <div class="source-row source-row-rich">
            <div class="source-main">
              <span class="source-name">${escapeHtml(s.file_name)}</span>
              <span class="source-meta">Added ${escapeHtml(formatDate(s.created_at))}.${s.status_detail && s.status_detail !== "Stored, not processed" ? ` ${escapeHtml(s.status_detail)}` : ""}</span>
              <span class="source-actions">${sourceActions(s)}</span>
            </div>
            <span class="source-status source-status-${cls}">${escapeHtml(label)}</span>
          </div>`;
        })
        .join("");
      historyContent.innerHTML = `<h2 class="card-title">${plural(sources.length, "source", "sources")} uploaded.</h2><div class="source-list">${rows}</div>`;
    }
  }

  if (reviewCard) {
    const count = (fn) => sources.filter(fn).length;
    const needsReview = count((s) => s.status === "needs_review");
    const csvPending = count((s) => s.status === "uploaded" && isCsvName(s.file_name));
    const aiPending = count((s) => s.status === "uploaded" && isAiReadable(s.file_name));
    const failed = count((s) => s.status === "failed");
    const stored = count((s) => s.status === "uploaded" && !isCsvName(s.file_name) && !isAiReadable(s.file_name));
    const lines = [];
    if (needsReview) lines.push(`${plural(needsReview, "file has", "files have")} trades waiting for your review.`);
    if (csvPending) lines.push(`${plural(csvPending, "CSV file was", "CSV files were")} saved but not imported.`);
    if (aiPending) lines.push(`${plural(aiPending, "file hasn't", "files haven't")} been read with AI yet.`);
    if (failed) lines.push(`${plural(failed, "file", "files")} couldn't be imported. The reason is shown in Input history.`);
    if (stored) lines.push(`${plural(stored, "file is", "files are")} stored but not processed. TradePulse can't read ${stored === 1 ? "this file type" : "these file types"} yet.`);
    if (lines.length) {
      reviewCard.innerHTML = `<h2 class="card-title">Some sources haven't become trades.</h2>${lines.map((l) => `<p class="card-copy">${escapeHtml(l)}</p>`).join("")}<p class="card-copy">Use the buttons next to each file in Input history.</p>`;
    } else restoreTemplate(reviewCard);
  }
}

/* =================================================================
   Overview page
   ================================================================= */
async function renderOverview() {
  if (!currentUser || !document.querySelector('[data-page="overview"]')) return;
  const tradingStat = document.getElementById("tradingDataStat");
  const tradingDetail = document.getElementById("tradingDataStatDetail");
  const journalStat = document.getElementById("journalStat");
  const journalDetail = document.getElementById("journalStatDetail");
  const insightsStat = document.getElementById("insightsStat");
  const insightsDetail = document.getElementById("insightsStatDetail");
  const activity = document.getElementById("activityContent");
  const next = document.getElementById("nextStepContent");
  const intro = document.getElementById("introCard");
  const period = document.getElementById("periodControl");

  setStat(tradingStat, tradingDetail, "Loading", "Checking your sources.");
  setStat(journalStat, journalDetail, "Loading", "Checking your journal.");
  setStat(insightsStat, insightsDetail, "Loading", "Checking your trades.");
  setRegionLoading(activity, "Loading recent activity.");
  setRegionLoading(next, "Working out what's next.");

  let sources;
  let trades;
  let rules;
  try {
    [sources, trades, rules] = await Promise.all([TP.getSources(), TP.getTrades(), TP.getRules().catch(() => [])]);
  } catch (err) {
    setStat(tradingStat, tradingDetail, "Couldn't load", "Refresh the page to try again.");
    setStat(journalStat, journalDetail, "Couldn't load", "Refresh the page to try again.");
    setStat(insightsStat, insightsDetail, "Couldn't load", "Refresh the page to try again.");
    setRegionError(activity, "Recent activity couldn't be loaded.", "");
    setRegionError(next, "Your next step couldn't be worked out.", "");
    return;
  }
  activity?.removeAttribute("aria-busy");
  next?.removeAttribute("aria-busy");

  const hasData = sources.length > 0 || trades.length > 0;
  if (intro) intro.hidden = hasData;

  // Trading data
  if (sources.length) {
    const c = { imported: 0, pending: 0, stored: 0, failed: 0, review: 0 };
    for (const s of sources) {
      const { cls } = sourceStatusLabel(s);
      if (cls === "processed") c.imported++;
      else if (cls === "failed") c.failed++;
      else if (cls === "needs_review") c.review++;
      else if (cls === "stored") c.stored++;
      else c.pending++;
    }
    const parts = [];
    if (c.imported) parts.push(`${c.imported} imported`);
    if (c.review) parts.push(`${c.review} to review`);
    if (c.pending) parts.push(`${c.pending} not imported`);
    if (c.stored) parts.push(`${c.stored} stored only`);
    if (c.failed) parts.push(`${c.failed} couldn't be imported`);
    setStat(tradingStat, tradingDetail, plural(sources.length, "source", "sources"), `${parts.join(", ")}.`);
  } else setStat(tradingStat, tradingDetail, "Not connected", "No source has been provided.");

  // Journal + Insights stats
  const summary = window.TradeAnalytics.summarise(trades);
  if (trades.length) {
    setStat(journalStat, journalDetail, plural(trades.length, "trade", "trades"), summary.withoutResult ? `${summary.withoutResult} without a result in R.` : "All with a result in R.");
  } else setStat(journalStat, journalDetail, "Empty", "Add trades or a journal source.");

  if (summary.countedTrades < window.TradeAnalytics.SMALL_SAMPLE) {
    setStat(insightsStat, insightsDetail, "Not enough data", `Insights need ${window.TradeAnalytics.SMALL_SAMPLE} trades with an R result. You have ${summary.countedTrades}.`);
  } else {
    const obs = window.TradeAnalytics.observations(trades);
    setStat(insightsStat, insightsDetail, obs.length ? plural(obs.length, "observation", "observations") : "No clear differences", obs.length ? "Calculated from your trades." : "Nothing stands out yet.");
  }

  const range = formatRange(summary.firstDate, summary.lastDate);
  if (period) period.textContent = range ? `Trades from ${range}` : trades.length ? "Trades without dates" : "No data yet";

  // Recent activity: real events only
  if (activity) {
    if (!hasData) restoreTemplate(activity);
    else {
      const events = [
        ...sources.map((s) => ({ when: s.processed_at || s.created_at, text: `${s.file_name}: ${sourceStatusLabel(s).label.toLowerCase()}` })),
      ];
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
      const recentTrades = trades.filter((t) => t.created_at >= weekAgo).length;
      const items = events
        .sort((a, b) => (a.when < b.when ? 1 : -1))
        .slice(0, 5)
        .map((e) => `<li><span>${escapeHtml(e.text)}</span><small>${escapeHtml(formatDate(e.when))}</small></li>`)
        .join("");
      activity.innerHTML = `
        <p class="label">Activity</p>
        <h2 class="card-title">${recentTrades ? `${plural(recentTrades, "trade", "trades")} added in the last 7 days.` : "No trades added in the last 7 days."}</h2>
        ${items ? `<ul class="activity-list">${items}</ul>` : ""}
        <a class="mini-link" href="journal.html">Go to Journal</a>`;
    }
  }

  // Next step: the most useful real piece of unfinished work
  if (next) {
    const needsReview = sources.find((s) => s.status === "needs_review");
    const csvPending = sources.find((s) => s.status === "uploaded" && isCsvName(s.file_name));
    const aiPending = sources.find((s) => s.status === "uploaded" && isAiReadable(s.file_name));
    const suggested = rules.filter((r) => r.status === "suggested").length;
    let html;
    if (!hasData) html = null;
    else if (needsReview) html = step("Review what the AI found.", `${needsReview.file_name} has trades waiting for your confirmation.`, `<button class="mini-link link-button" type="button" data-review-source="${escapeHtml(needsReview.id)}">Review now</button>`);
    else if (suggested) html = step(`Check ${plural(suggested, "suggested rule", "suggested rules")}.`, "The AI found rules in your documents. They stay suggestions until you accept them.", `<a class="mini-link" href="playbook.html">Open Playbook</a>`);
    else if (csvPending) html = step(`Import ${csvPending.file_name}.`, "It's saved, but its rows haven't been reviewed yet.", `<button class="mini-link link-button" type="button" data-review-source="${escapeHtml(csvPending.id)}">Review rows</button>`);
    else if (aiPending) html = step(`Read ${aiPending.file_name} with AI.`, "TradePulse can look for trades in it and show you before adding anything.", `<button class="mini-link link-button" type="button" data-read-ai="${escapeHtml(aiPending.id)}">Read with AI</button>`);
    else if (summary.withoutResult) html = step(`Add R results to ${plural(summary.withoutResult, "trade", "trades")}.`, "Trades without a result in R aren't included in analytics.", `<a class="mini-link" href="journal.html">Open Journal</a>`);
    else if (summary.countedTrades < window.TradeAnalytics.SMALL_SAMPLE) html = step("Keep adding trades.", `Insights need ${window.TradeAnalytics.SMALL_SAMPLE} trades with an R result. You have ${summary.countedTrades}.`, `<button class="mini-link link-button" type="button" data-open-upload>Add trades</button>`);
    else html = step("See what your trades show.", "Your calculated observations are ready.", `<a class="mini-link" href="insights.html">Open Insights</a>`);
    if (html) next.innerHTML = html;
    else restoreTemplate(next);
  }

  function step(title, copy, action) {
    return `<p class="label">Next step</p><h2 class="card-title">${escapeHtml(title)}</h2><p class="card-copy">${escapeHtml(copy)}</p>${action}`;
  }
}

document.addEventListener("tp:data-changed", () => {
  renderSourcesSummary();
  renderOverview();
});
