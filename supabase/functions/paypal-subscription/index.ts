// paypal-subscription: everything the browser needs for a PayPal subscription,
// except the approval itself (which happens on PayPal's own pages).
//
// The browser never decides what a user is entitled to. It tells us which
// subscription PayPal approved; we ask PayPal what that subscription actually
// is, and only then write a row. The subscriptions table is server-writable
// only, so a forged request can't grant a plan.
//
// Actions: "config" (no session needed), "claim", "refresh", "cancel",
// and "setup" (creates the PayPal product, plans and webhook once).

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import {
  CORS,
  PayPalNotConfigured,
  accessToken,
  mapStatus,
  paypalEnv,
  paypalFetch,
  reply,
  setting,
  storedPlans,
} from "./paypal.ts";

// PayPal subscription ids look like I-BW452GLLEP1G.
const SUBSCRIPTION_ID = /^[A-Z0-9-]{3,50}$/;

// What "setup" creates. Prices are in the plan's own currency; PayPal has no
// ZAR, so these are USD and the Rand price is shown beside them in the app.
const SETUP_PLANS = [
  { code: "starter", name: "TradePulse Starter", description: "Manual journaling, CSV import and analytics you can check.", value: "19" },
  { code: "pro", name: "TradePulse Pro", description: "Everything in Starter, plus AI reading of statements, screenshots and notes.", value: "49" },
];

const WEBHOOK_EVENTS = [
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "PAYMENT.SALE.COMPLETED",
];

/** Reads one subscription from PayPal and shapes it into a row we can store. */
// deno-lint-ignore no-explicit-any
async function fetchSubscription(admin: any, subscriptionId: string) {
  const res = await paypalFetch(`/v1/billing/subscriptions/${subscriptionId}`);
  if (res.status === 404) return { error: "PayPal doesn't recognise that subscription." as const };
  if (!res.ok) return { error: `PayPal returned ${res.status}.` as const };

  const sub = await res.json();
  const planId = String(sub?.plan_id || "");
  const plans = await storedPlans(admin);
  const match = plans.find((p) => p.provider_plan_id === planId);
  if (!match) return { error: "That subscription isn't for a TradePulse plan." as const };

  const status = mapStatus(sub?.status);
  if (!status) return { error: `PayPal reported a state we don't handle (${sub?.status}).` as const };

  const price = sub?.billing_info?.last_payment?.amount;
  return {
    row: {
      provider: "paypal",
      environment: paypalEnv().env,
      provider_subscription_id: String(sub.id),
      provider_plan_id: planId,
      plan_code: match.plan_code,
      status,
      amount: price?.value ? Number(price.value) : match.amount,
      currency: price?.currency_code ? String(price.currency_code) : match.currency,
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const { env } = paypalEnv();

  // ---- config: what the browser needs to render the buttons ----
  if (action === "config") {
    if (!clientId || !Deno.env.get("PAYPAL_CLIENT_SECRET")) {
      return reply(200, { configured: false, environment: env, plans: [] });
    }
    const plans = (await storedPlans(admin)).map((p) => ({
      code: p.plan_code,
      plan_id: p.provider_plan_id,
      amount: p.amount === null ? null : String(p.amount),
      currency: p.currency,
    }));
    return reply(200, { configured: true, environment: env, client_id: clientId, plans });
  }

  // ---- everything else needs a signed-in user ----
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return reply(401, { error: "Please log in again." });
  const userId = userData.user.id;
  const userEmail = (userData.user.email || "").toLowerCase();

  try {
    await accessToken();
  } catch (e) {
    if (e instanceof PayPalNotConfigured) return reply(503, { error: "PayPal isn't set up on this project yet." });
    return reply(502, { error: "Couldn't reach PayPal just now. Nothing was changed." });
  }

  // ---- setup: create the product, plans and webhook, once ----
  // Creating plans is not something any signed-in user may do, so it is
  // restricted to the one account named in PAYPAL_SETUP_EMAIL.
  if (action === "setup") {
    const owner = (Deno.env.get("PAYPAL_SETUP_EMAIL") || "").toLowerCase();
    if (!owner) return reply(503, { error: "PAYPAL_SETUP_EMAIL isn't set, so setup is disabled." });
    if (userEmail !== owner) return reply(403, { error: "Only the project owner can run setup." });

    const done: string[] = [];

    // 1. Product. Reused if setup has run before.
    let productId = await setting(admin, "product_id");
    if (!productId) {
      const res = await paypalFetch("/v1/catalogs/products", {
        method: "POST",
        body: JSON.stringify({
          name: "TradePulse",
          description: "Trading journal and review",
          type: "SERVICE",
          category: "SOFTWARE",
        }),
      });
      if (!res.ok) return reply(502, { error: `Couldn't create the product (PayPal returned ${res.status}).`, done });
      productId = String((await res.json()).id);
      await admin.from("billing_provider_settings").upsert(
        { provider: "paypal", environment: env, key: "product_id", value: productId, updated_at: new Date().toISOString() },
        { onConflict: "provider,environment,key" },
      );
      done.push(`Created product ${productId}`);
    } else {
      done.push(`Reused product ${productId}`);
    }

    // 2. Plans. A plan's price is fixed once created, so an existing plan is
    // left exactly as it is rather than silently replaced.
    const existing = await storedPlans(admin);
    for (const plan of SETUP_PLANS) {
      if (existing.some((p) => p.plan_code === plan.code)) {
        done.push(`${plan.code}: already exists, left alone`);
        continue;
      }
      const res = await paypalFetch("/v1/billing/plans", {
        method: "POST",
        body: JSON.stringify({
          product_id: productId,
          name: plan.name,
          description: plan.description,
          billing_cycles: [{
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0, // bills until cancelled
            pricing_scheme: { fixed_price: { value: plan.value, currency_code: "USD" } },
          }],
          payment_preferences: {
            auto_bill_outstanding: true,
            setup_fee_failure_action: "CONTINUE",
            payment_failure_threshold: 3,
          },
        }),
      });
      if (!res.ok) {
        done.push(`${plan.code}: FAILED (PayPal returned ${res.status})`);
        continue;
      }
      const created = await res.json();
      await admin.from("billing_plans").upsert({
        provider: "paypal",
        environment: env,
        plan_code: plan.code,
        provider_product_id: productId,
        provider_plan_id: String(created.id),
        amount: Number(plan.value),
        currency: "USD",
        active: true,
      }, { onConflict: "provider,environment,plan_code" });
      done.push(`${plan.code}: created ${created.id} at USD ${plan.value}/month`);
    }

    // 3. Webhook, pointed back at this project's own webhook function.
    let webhookId = await setting(admin, "webhook_id");
    if (!webhookId) {
      const url = `${supabaseUrl}/functions/v1/paypal-webhook`;
      const res = await paypalFetch("/v1/notifications/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) }),
      });
      if (res.ok) {
        webhookId = String((await res.json()).id);
        await admin.from("billing_provider_settings").upsert(
          { provider: "paypal", environment: env, key: "webhook_id", value: webhookId, updated_at: new Date().toISOString() },
          { onConflict: "provider,environment,key" },
        );
        done.push(`Registered webhook ${webhookId} for ${url}`);
      } else {
        const detail = await res.text();
        done.push(`Webhook NOT registered (PayPal returned ${res.status}). Without it, cancellations and failed payments made at PayPal won't reach TradePulse. ${detail.slice(0, 200)}`);
      }
    } else {
      done.push(`Reused webhook ${webhookId}`);
    }

    return reply(200, { environment: env, done });
  }

  // ---- claim / refresh ----
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

    const result = await fetchSubscription(admin, subscriptionId);
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
