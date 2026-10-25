// paypal-webhook: PayPal's own notifications about subscription changes.
//
// Deploy with --no-verify-jwt: PayPal is not a signed-in user. Authenticity is
// established instead by PayPal's signature verification endpoint, and a
// request that fails it is recorded and ignored.
//
// Every event is written down before it is acted on, keyed by PayPal's event
// id. PayPal retries on any non-2xx response, so the same event will arrive
// again; the unique key is what stops it being applied twice.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { mapStatus, paypalEnv, paypalFetch, setting, storedPlans } from "./paypal.ts";

const ok = (note: string) => new Response(JSON.stringify({ ok: true, note }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

/** The five headers PayPal signs each delivery with. */
function signatureHeaders(req: Request) {
  return {
    auth_algo: req.headers.get("paypal-auth-algo") || "",
    cert_url: req.headers.get("paypal-cert-url") || "",
    transmission_id: req.headers.get("paypal-transmission-id") || "",
    transmission_sig: req.headers.get("paypal-transmission-sig") || "",
    transmission_time: req.headers.get("paypal-transmission-time") || "",
  };
}

/**
 * Creates a subscription row for a payment the browser never confirmed.
 * Returns a note describing what happened, for the event log.
 */
// deno-lint-ignore no-explicit-any
async function createFromPayPal(admin: any, subscriptionId: string, userId: string, eventStatus: string): Promise<string> {
  const res = await paypalFetch(`/v1/billing/subscriptions/${subscriptionId}`);
  if (!res.ok) return `Could not read the subscription from PayPal to create it (${res.status}). It is still unrecorded.`;

  const sub = await res.json();
  const planId = String(sub?.plan_id || "");
  const match = (await storedPlans(admin)).find((p) => p.provider_plan_id === planId);
  if (!match) return `Subscription is for plan ${planId}, which is not a TradePulse plan. Left unrecorded.`;

  const status = mapStatus(sub?.status) || eventStatus;
  const price = sub?.billing_info?.last_payment?.amount;

  const { error } = await admin.from("subscriptions").upsert({
    user_id: userId,
    provider: "paypal",
    environment: paypalEnv().env,
    provider_subscription_id: subscriptionId,
    provider_plan_id: planId,
    plan_code: match.plan_code,
    status,
    amount: price?.value ? Number(price.value) : match.amount,
    currency: price?.currency_code ? String(price.currency_code) : match.currency,
    current_period_end: sub?.billing_info?.next_billing_time || null,
    cancelled_at: status === "cancelled" || status === "expired" ? new Date().toISOString() : null,
  }, { onConflict: "provider,provider_subscription_id" });

  if (error) return `Tried to create the subscription from the webhook but saving failed: ${error.message}`;
  return `Created the subscription from the webhook (${status}); the browser never confirmed it.`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  let event: Record<string, any>;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const eventId = String(event?.id || "");
  const eventType = String(event?.event_type || "");
  if (!eventId || !eventType) return new Response("Bad request", { status: 400 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Already seen? Then this is a retry of something we finished. Say so and
  // stop, rather than applying it a second time.
  const { data: seen } = await admin
    .from("billing_webhook_events")
    .select("id, handled")
    .eq("provider", "paypal")
    .eq("event_id", eventId)
    .maybeSingle();
  if (seen?.handled) return ok("already handled");

  // The webhook id is whatever "setup" registered, with the secret as an
  // override for a webhook registered by hand.
  const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID") || (await setting(admin, "webhook_id"));
  let verification: "verified" | "rejected" = "rejected";
  let note = "";

  if (!webhookId) {
    note = "No webhook id is on record, so this delivery could not be verified.";
  } else {
    try {
      const res = await paypalFetch("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: JSON.stringify({
          ...signatureHeaders(req),
          webhook_id: webhookId,
          // PayPal requires the event exactly as received.
          webhook_event: event,
        }),
      });
      const body = res.ok ? await res.json() : null;
      verification = body?.verification_status === "SUCCESS" ? "verified" : "rejected";
      if (verification === "rejected") note = `PayPal did not verify this delivery (${body?.verification_status ?? res.status}).`;
    } catch {
      note = "Could not reach PayPal to verify this delivery.";
    }
  }

  const record = {
    provider: "paypal",
    event_id: eventId,
    event_type: eventType,
    verification,
    payload: event,
    handled: false,
    handling_note: note || null,
  };

  if (verification === "rejected") {
    await admin.from("billing_webhook_events").upsert(
      { ...record, handled: true },
      { onConflict: "provider,event_id" },
    );
    // 200 deliberately: the signature is wrong, so retrying changes nothing.
    return ok("rejected");
  }

  // ---- apply it ----
  const resource = event?.resource || {};
  let applied = "";

  if (eventType.startsWith("BILLING.SUBSCRIPTION.")) {
    const subscriptionId = String(resource?.id || "");
    const status = mapStatus(resource?.status);

    if (!subscriptionId) {
      applied = "No subscription id on the event.";
    } else {
      // The row may not exist yet if the webhook beats the browser's claim
      // call. custom_id carries the user id we set when creating it.
      const { data: row } = await admin
        .from("subscriptions")
        .select("id, user_id")
        .eq("provider", "paypal")
        .eq("provider_subscription_id", subscriptionId)
        .maybeSingle();

      const userId = row?.user_id || (typeof resource?.custom_id === "string" ? resource.custom_id : null);

      if (!userId) {
        applied = "No TradePulse account is linked to this subscription yet.";
      } else if (!status) {
        applied = `Unrecognised subscription state (${resource?.status}).`;
      } else {
        const update: Record<string, unknown> = {
          status,
          current_period_end: resource?.billing_info?.next_billing_time || null,
        };
        if (status === "cancelled" || status === "expired") update.cancelled_at = new Date().toISOString();

        if (row) {
          await admin.from("subscriptions").update(update).eq("id", row.id);
          applied = `Subscription set to ${status}.`;
        } else if (status === "approval_pending") {
          // Created at PayPal but not approved by anyone yet. Nothing has been
          // paid, and recording it would make an abandoned checkout look like
          // a subscription, so it is noted and left alone.
          applied = "Created at PayPal, not yet approved. Nothing recorded.";
        } else {
          // No row yet: the person approved at PayPal and then closed the tab
          // before the browser could tell us. They have been charged, so the
          // subscription is created here instead of being left unrecorded.
          // The event's own fields are not trusted for this - the subscription
          // is re-read from PayPal, exactly as the browser's claim does.
          applied = await createFromPayPal(admin, subscriptionId, userId, status);
        }
      }
    }
  } else if (eventType === "PAYMENT.SALE.COMPLETED" || eventType === "PAYMENT.SALE.REFUNDED" || eventType === "PAYMENT.SALE.REVERSED") {
    // A renewal charge. The subscription's own state is what we store, so
    // re-read it rather than inferring anything from the payment.
    const subscriptionId = String(resource?.billing_agreement_id || "");
    if (!subscriptionId) {
      applied = "Payment event with no subscription attached.";
    } else {
      const res = await paypalFetch(`/v1/billing/subscriptions/${subscriptionId}`);
      if (res.ok) {
        const sub = await res.json();
        const status = mapStatus(sub?.status);
        if (status) {
          await admin
            .from("subscriptions")
            .update({ status, current_period_end: sub?.billing_info?.next_billing_time || null })
            .eq("provider", "paypal")
            .eq("provider_subscription_id", subscriptionId);
          applied = `Re-read the subscription after ${eventType}; state is ${status}.`;
        } else {
          applied = `Re-read the subscription but its state (${sub?.status}) is one we don't handle.`;
        }
      } else {
        applied = `Could not re-read the subscription (PayPal returned ${res.status}).`;
      }
    }
  } else {
    applied = "Event type not handled.";
  }

  await admin.from("billing_webhook_events").upsert(
    { ...record, handled: true, handling_note: applied },
    { onConflict: "provider,event_id" },
  );

  return ok(applied);
});
