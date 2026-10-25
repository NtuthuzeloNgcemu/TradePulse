// paypal-subscription: everything the browser needs for a PayPal subscription,
// except the approval itself (which happens on PayPal's own pages).
//
// The browser never decides what a user is entitled to. It tells us which
// subscription PayPal approved; we ask PayPal what that subscription actually
// is, and only then write a row. The subscriptions table is server-writable
// only, so a forged request can't grant a plan.
//
// Actions: "config" (no session needed), "claim", "refresh", "cancel".

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import {
  CORS,
  PayPalNotConfigured,
  accessToken,
  mapStatus,
  paypalEnv,
  paypalFetch,
  planCodeFor,
  planIds,
  reply,
} from "../_shared/paypal.ts";

// PayPal subscription ids look like I-BW452GLLEP1G.
const SUBSCRIPTION_ID = /^[A-Z0-9-]{3,50}$/;

type PlanInfo = { code: string; plan_id: string; amount: string | null; currency: string | null };

// Plan prices come from PayPal, not from our own copy, so the page can never
// advertise a price different from the one PayPal will charge. Cached briefly
// because the pricing page calls this on every visit.
let planCache: { at: number; plans: PlanInfo[] } | null = null;

async function describePlans(): Promise<PlanInfo[]> {
  if (planCache && Date.now() - planCache.at < 10 * 60 * 1000) return planCache.plans;

  const plans: PlanInfo[] = [];
  for (const [code, planId] of Object.entries(planIds())) {
    let amount: string | null = null;
    let currency: string | null = null;
    try {
      const res = await paypalFetch(`/v1/billing/plans/${planId}`);
      if (res.ok) {
        const plan = await res.json();
        const cycles = Array.isArray(plan?.billing_cycles) ? plan.billing_cycles : [];
        const regular = cycles.find((c: Record<string, unknown>) => c?.tenure_type === "REGULAR");
        const price = regular?.pricing_scheme?.fixed_price;
        if (price?.value) {
          amount = String(price.value);
          currency = String(price.currency_code || "");
        }
      }
    } catch {
      // A price we couldn't read is reported as unknown, never guessed.
    }
    plans.push({ code, plan_id: planId, amount, currency });
  }
  planCache = { at: Date.now(), plans };
  return plans;
}

/** Reads one subscription from PayPal and shapes it into a row we can store. */
async function fetchSubscription(subscriptionId: string) {
  const res = await paypalFetch(`/v1/billing/subscriptions/${subscriptionId}`);
  if (res.status === 404) return { error: "PayPal doesn't recognise that subscription." as const };
  if (!res.ok) return { error: `PayPal returned ${res.status}.` as const };

  const sub = await res.json();
  const planId = String(sub?.plan_id || "");
  const planCode = planCodeFor(planId);
  if (!planCode) return { error: "That subscription isn't for a TradePulse plan." as const };

  const status = mapStatus(sub?.status);
  if (!status) return { error: `PayPal reported a state we don't handle (${sub?.status}).` as const };

  const price = sub?.billing_info?.last_payment?.amount;
  return {
    sub,
    row: {
      provider: "paypal",
      environment: paypalEnv().env,
      provider_subscription_id: String(sub.id),
      provider_plan_id: planId,
      plan_code: planCode,
      status,
      amount: price?.value ? Number(price.value) : null,
      currency: price?.currency_code ? String(price.currency_code) : null,
      current_period_end: sub?.billing_info?.next_billing_time || null,
      cancelled_at: status === "cancelled" ? new Date().toISOString() : null,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) || {};
  } catch {
    /* handled below */
  }
  const action = String(body.action || "");

  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const { env } = paypalEnv();

  // ---- config: what the browser needs to render the buttons ----
  if (action === "config") {
    if (!clientId || !Deno.env.get("PAYPAL_CLIENT_SECRET")) {
      return reply(200, { configured: false, environment: env, plans: [] });
    }
    try {
      return reply(200, { configured: true, environment: env, client_id: clientId, plans: await describePlans() });
    } catch (e) {
      if (e instanceof PayPalNotConfigured) return reply(200, { configured: false, environment: env, plans: [] });
      return reply(502, { error: "Couldn't reach PayPal just now." });
    }
  }

  // ---- everything else needs a signed-in user ----
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return reply(401, { error: "Please log in again." });
  const userId = userData.user.id;

  try {
    await accessToken();
  } catch (e) {
    if (e instanceof PayPalNotConfigured) return reply(503, { error: "PayPal isn't set up on this project yet." });
    return reply(502, { error: "Couldn't reach PayPal just now. Nothing was changed." });
  }

  // ---- claim: the browser says PayPal approved a subscription ----
  if (action === "claim" || action === "refresh") {
    let subscriptionId = String(body.subscription_id || "");

    if (action === "refresh") {
      const { data: existing } = await userClient
        .from("subscriptions")
        .select("provider_subscription_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!existing) return reply(200, { subscription: null });
      subscriptionId = existing.provider_subscription_id;
    }

    if (!SUBSCRIPTION_ID.test(subscriptionId)) return reply(400, { error: "Missing subscription." });

    const result = await fetchSubscription(subscriptionId);
    if ("error" in result) return reply(400, { error: result.error });

    // A subscription already recorded against a different user is not ours to
    // move. This is what stops someone claiming another person's subscription.
    const { data: owned } = await admin
      .from("subscriptions")
      .select("user_id")
      .eq("provider", "paypal")
      .eq("provider_subscription_id", subscriptionId)
      .maybeSingle();
    if (owned && owned.user_id !== userId) {
      return reply(409, { error: "That subscription belongs to another account." });
    }

    const { data: saved, error: saveError } = await admin
      .from("subscriptions")
      .upsert({ user_id: userId, ...result.row }, { onConflict: "provider,provider_subscription_id" })
      .select()
      .single();
    if (saveError) return reply(500, { error: "PayPal approved it, but saving it here failed. Contact support with your subscription id." });

    return reply(200, { subscription: saved });
  }

  // ---- cancel ----
  if (action === "cancel") {
    const { data: current } = await userClient
      .from("subscriptions")
      .select("provider_subscription_id, status")
      .eq("user_id", userId)
      .in("status", ["active", "approved", "suspended"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!current) return reply(404, { error: "There's no active subscription to cancel." });

    const res = await paypalFetch(`/v1/billing/subscriptions/${current.provider_subscription_id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: String(body.reason || "Cancelled by the account holder") }),
    });
    // 204 is success. Anything else leaves the subscription as it was.
    if (res.status !== 204) {
      return reply(502, { error: "PayPal didn't accept the cancellation. Nothing was changed." });
    }

    await admin
      .from("subscriptions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("provider", "paypal")
      .eq("provider_subscription_id", current.provider_subscription_id);

    return reply(200, { cancelled: true });
  }

  return reply(400, { error: "Unknown action." });
});
