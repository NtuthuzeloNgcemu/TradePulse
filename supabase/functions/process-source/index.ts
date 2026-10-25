// process-source: reads one of the signed-in user's stored files with AI (Groq)
// and saves what it found for the user to review. It never creates trades.
// Suggested playbook rules are saved with status "suggested" and need the
// user's confirmation before they become active.
//
// Secrets: GROQ_API_KEY (required). Optional: GROQ_TEXT_MODEL, GROQ_VISION_MODEL.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { extractText, getDocumentProxy } from "npm:unpdf@1.8.1";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  MAX_IMAGE_BYTES,
  buildUserContent,
  fileKind,
  imageMime,
  parseModelJson,
  sanitiseExtraction,
  selectPages,
} from "./lib.ts";

const DAILY_LIMIT = 25; // AI reads per user per 24 hours

// Groq's catalogue changes, and not every account has every model, so the
// model is resolved against the account's own list instead of hard-coded.
// An env override (GROQ_TEXT_MODEL / GROQ_VISION_MODEL) always wins.
const TEXT_PREFERENCE = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];
// Image-capable models, best first. Groq retired the Llama 4 vision models in
// 2026; qwen3.8-27b takes images and supports JSON mode, so it leads the list.
const VISION_PREFERENCE = [
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
];
const NOT_CHAT = /whisper|tts|guard|embed|moderation|playai|orpheus|distil/i;
// Not every image-capable model says "vision" in its name
const LIKELY_VISION = /vision|scout|maverick|llama-4|omni|multimodal|qwen3\.[89]|vl\b/i;

let modelCache: string[] | null = null;

async function accountModels(apiKey: string): Promise<string[]> {
  if (modelCache) return modelCache;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error("groq model list failed", res.status);
      return [];
    }
    const body = await res.json();
    modelCache = (body?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    console.log("groq models available:", modelCache.join(", "));
    return modelCache;
  } catch (err) {
    console.error("groq model list error", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Pick a model this account can actually use. Returns null when none fits. */
async function pickModel(apiKey: string, kind: "text" | "vision"): Promise<string | null> {
  const override = Deno.env.get(kind === "vision" ? "GROQ_VISION_MODEL" : "GROQ_TEXT_MODEL");
  if (override) return override;

  const preference = kind === "vision" ? VISION_PREFERENCE : TEXT_PREFERENCE;
  const available = await accountModels(apiKey);
  if (!available.length) return preference[0]; // list unavailable: try the default and report the real error

  const exact = preference.find((id) => available.includes(id));
  if (exact) return exact;

  const usable = available.filter((id) => !NOT_CHAT.test(id));
  if (kind === "vision") return usable.find((id) => LIKELY_VISION.test(id)) ?? null;
  return usable[0] ?? null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // The user's own client: every read goes through row-level security
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return reply(401, { error: "Please log in again." });
  const userId = userData.user.id;

  let sourceId = "";
  try {
    sourceId = String((await req.json())?.source_id || "");
  } catch {
    /* handled below */
  }
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return reply(400, { error: "Missing source." });

  // RLS guarantees this only returns the caller's own source
  const { data: source, error: sourceError } = await userClient
    .from("sources")
    .select("id, user_id, file_name, file_type, storage_path, status, file_size")
    .eq("id", sourceId)
    .maybeSingle();
  if (sourceError || !source || source.user_id !== userId) return reply(404, { error: "File not found." });

  const kind = fileKind(source.file_type, source.file_name);
  if (!kind) return reply(400, { error: "TradePulse can't read this file type with AI yet." });
  if (source.status === "processing") return reply(409, { error: "This file is already being read." });

  // AI reading is a paid feature, and it costs real money per call, so the
  // check is here rather than in the browser. Hiding the button would not
  // stop anyone calling this function directly.
  const { data: plan, error: planError } = await admin.rpc("current_plan", { uid: userId });
  if (planError) return reply(503, { error: "Couldn't check your plan just now. Nothing was read." });
  if (plan !== "pro" && plan !== "desk") {
    return reply(402, {
      error: "AI reading is part of Pro. Your file is still stored and nothing was sent anywhere.",
      upgrade: true,
    });
  }

  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) return reply(503, { error: "AI reading isn't set up yet. The Groq API key hasn't been added." });

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin
    .from("sources")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("extracted_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) {
    return reply(429, { error: `You've used today's limit of ${DAILY_LIMIT} AI reads. Try again tomorrow.` });
  }

  const setStatus = (status: string, detail: string | null, extra: Record<string, unknown> = {}) =>
    admin.from("sources").update({ status, status_detail: detail, ...extra }).eq("id", source.id).eq("user_id", userId);

  await setStatus("processing", "Reading with AI");

  // Any failure from here returns the file to a state the user can retry from
  const fail = async (status: number, message: string, retryable = false) => {
    await setStatus(retryable ? "uploaded" : "failed", message);
    return reply(status, { error: message });
  };

  try {
    const { data: blob, error: dlError } = await admin.storage.from("trading-sources").download(source.storage_path);
    if (dlError || !blob) return await fail(500, "The stored file couldn't be opened.", true);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let model = "";
    let userContent: unknown;
    let readInfo: Record<string, unknown> = {};

    if (kind === "image") {
      if (bytes.length > MAX_IMAGE_BYTES) {
        return await fail(413, "Images must be 10 MB or smaller to be read with AI. Try a smaller screenshot.");
      }
      const visionModel = await pickModel(apiKey, "vision");
      if (!visionModel) {
        return await fail(503, "Your Groq account has no model that can read images right now. CSV, PDF and text files still work. Groq changes which models it offers, so this may come back.");
      }
      model = visionModel;
      userContent = buildUserContent("image", source.file_name, `data:${imageMime(source.file_name)};base64,${toBase64(bytes)}`);
      readInfo = { input: "image" };
    } else {
      let pages: string[];
      if (kind === "pdf") {
        const pdf = await getDocumentProxy(bytes);
        const { text } = await extractText(pdf, { mergePages: false });
        pages = Array.isArray(text) ? text : [String(text)];
      } else {
        pages = [new TextDecoder("utf-8", { fatal: false }).decode(bytes)];
      }
      const selected = selectPages(pages);
      if (selected.totalChars < 40) {
        return await fail(
          422,
          kind === "pdf"
            ? "This PDF has no readable text (it may be a scanned image). Upload a screenshot of the page instead."
            : "This file has no readable text.",
        );
      }
      const textModel = await pickModel(apiKey, "text");
      if (!textModel) {
        return await fail(503, "Your Groq account has no model available to read documents right now. Check the models on your Groq account.");
      }
      model = textModel;
      userContent = buildUserContent("text", source.file_name, selected.text);
      readInfo = { input: kind, pages_read: selected.pagesRead, pages_total: selected.pagesTotal, truncated: selected.truncated };
    }

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 2500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (groqRes.status === 429) return await fail(429, "The free AI limit was reached for now. Try again in a few minutes.", true);
    if (groqRes.status === 413) return await fail(413, "This file is too long to read in one go. Split it into smaller files.");
    if (!groqRes.ok) {
      const detail = (await groqRes.text()).slice(0, 400);
      console.error("groq error", groqRes.status, "model:", model, detail);
      if (groqRes.status === 404 || groqRes.status === 400) {
        modelCache = null; // the catalogue may have changed under us
        return await fail(
          503,
          `The AI model "${model}" isn't available on this Groq account, so the file couldn't be read. Nothing was changed.`,
          true,
        );
      }
      if (groqRes.status === 401 || groqRes.status === 403) {
        return await fail(503, "The Groq API key was rejected. Check the GROQ_API_KEY secret in Supabase.", true);
      }
      return await fail(502, "The AI service didn't respond properly. Try again later.", true);
    }

    const payload = await groqRes.json();
    const content = payload?.choices?.[0]?.message?.content ?? "";
    const parsed = parseModelJson(content);
    if (!parsed) return await fail(502, "The AI reply couldn't be read. Try again.", true);

    const extraction = sanitiseExtraction(parsed);
    const record = { ...extraction, ...readInfo, model, prompt_version: PROMPT_VERSION };

    // Suggested rules: saved as suggestions only, never as active rules
    let rulesSuggested = 0;
    if (extraction.rules.length) {
      const { data: existing } = await admin.from("playbook_rules").select("rule_text").eq("user_id", userId);
      const known = new Set((existing || []).map((r: { rule_text: string }) => r.rule_text.trim().toLowerCase()));
      const fresh = extraction.rules.filter((r) => !known.has(r.rule_text.toLowerCase()));
      if (fresh.length) {
        const { error: ruleError } = await admin.from("playbook_rules").insert(
          fresh.map((r) => ({ user_id: userId, rule_text: r.rule_text, evidence: r.evidence, status: "suggested", origin: "ai", source_id: source.id })),
        );
        if (!ruleError) rulesSuggested = fresh.length;
      }
    }

    const found = extraction.trades.length > 0 || rulesSuggested > 0;
    const parts = [];
    if (extraction.trades.length) parts.push(`${extraction.trades.length} possible trade${extraction.trades.length === 1 ? "" : "s"} to review`);
    if (rulesSuggested) parts.push(`${rulesSuggested} suggested rule${rulesSuggested === 1 ? "" : "s"} in Playbook`);
    const detail = found ? `Read by AI: ${parts.join(", ")}.` : "Read by AI. No trades or stated rules were found.";

    await setStatus(extraction.trades.length ? "needs_review" : "processed", detail, {
      extraction: record,
      extracted_by: `groq:${model} ${PROMPT_VERSION}`,
      extracted_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
    });

    return reply(200, { ok: true, trades: extraction.trades.length, rules_suggested: rulesSuggested, detail, extraction: record });
  } catch (err) {
    console.error("process-source failed", err instanceof Error ? err.message : String(err));
    return await fail(500, "Something went wrong while reading this file. Try again later.", true);
  }
});
