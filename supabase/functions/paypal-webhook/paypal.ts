// Shared PayPal helpers.
//
// NOTE: this file is duplicated in paypal-subscription/ and paypal-webhook/.
// Edge functions deploy independently and a parent-directory import does not
// survive deployment, and this project has no build step to copy it. Keep the
// two copies identical; the canonical text is this header plus everything
// below it.
//
// Secrets (set on the Supabase project, never in code or in the browser):
//   PAYPAL_CLIENT_ID      - also sent to the browser; public by design
//   PAYPAL_CLIENT_SECRET  - server only
//   PAYPAL_ENV            - "sandbox" (default) or "live"
//   PAYPAL_SETUP_EMAIL    - only this signed-in account may run "setup"
//
// Plan ids and the webhook id are NOT secrets: the app creates them itself
// through the "setup" action and stores them in billing_plans and
// billing_provider_settings, so setting payments up needs no terminal.
//
// Base URLs per PayPal's REST docs: sandbox api-m.sandbox.paypal.com,
// live api-m.paypal.com.

export type PlanCode = "starter" | "pro" | "desk";
export const PLAN_CODES: PlanCode[] = ["starter", "pro", "desk"];

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export function paypalEnv(): { env: "sandbox" | "live"; base: string } {
  const env = Deno.env.get("PAYPAL_ENV") === "live" ? "live" : "sandbox";
  return { env, base: env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com" };
}

export type StoredPlan = {
  plan_code: string;
  provider_plan_id: string;
  amount: number | null;
  currency: string | null;
};

/** The plans this project created, for the environment it is pointed at. */
// deno-lint-ignore no-explicit-any
export async function storedPlans(admin: any): Promise<StoredPlan[]> {
  const { data } = await admin
    .from("billing_plans")
    .select("plan_code, provider_plan_id, amount, currency")
    .eq("provider", "paypal")
    .eq("environment", paypalEnv().env)
    .eq("active", true);
  return data || [];
}

// deno-lint-ignore no-explicit-any
export async function setting(admin: any, key: string): Promise<string | null> {
  const { data } = await admin
    .from("billing_provider_settings")
    .select("value")
    .eq("provider", "paypal")
    .eq("environment", paypalEnv().env)
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

// One token per warm instance. PayPal tokens last hours; this refreshes a
// minute early rather than risking a request with an expired one.
let cached: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const id = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!id || !secret) throw new PayPalNotConfigured();

  const { base } = paypalEnv();
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal rejected the credentials (${res.status})`);

  const body = await res.json();
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000,
  };
  return cached.token;
}

export class PayPalNotConfigured extends Error {
  constructor() {
    super("PayPal isn't set up yet.");
    this.name = "PayPalNotConfigured";
  }
}

export async function paypalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { base } = paypalEnv();
  const token = await accessToken();
  return await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/**
 * PayPal's own subscription states, lowercased to match our check constraint.
 * An unrecognised state is returned as null rather than guessed at, so the
 * caller can record that it saw something it doesn't understand.
 */
const STATUSES = ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"];
export function mapStatus(status: unknown): string | null {
  const s = String(status || "").toUpperCase();
  return STATUSES.includes(s) ? s.toLowerCase() : null;
}
