// delete-account: permanently deletes the signed-in user's account.
// Removes their stored files, then the auth user. Their profile, sources,
// trades, insights and playbook rules are removed by ON DELETE CASCADE.
// The request must include { "confirm": "DELETE" }.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return reply(401, { error: "Please log in again." });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }
  if (body.confirm !== "DELETE") return reply(400, { error: "Confirmation missing." });

  const userId = data.user.id;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Remove every stored file in the user's folder, page by page
  const bucket = admin.storage.from("trading-sources");
  for (let guard = 0; guard < 100; guard++) {
    const { data: files, error: listError } = await bucket.list(userId, { limit: 100 });
    if (listError) return reply(500, { error: "Your files couldn't be removed. Nothing was deleted." });
    if (!files || !files.length) break;
    const { error: removeError } = await bucket.remove(files.map((f) => `${userId}/${f.name}`));
    if (removeError) return reply(500, { error: "Your files couldn't be removed. Try again." });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) return reply(500, { error: "Your files were removed, but the account couldn't be deleted. Try again." });

  return reply(200, { ok: true });
});
