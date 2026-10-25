// Shared PayPal helpers.
//
// Secrets (set on the Supabase project, never in code or in the browser):
//   PAYPAL_CLIENT_ID      - also sent to the browser; public by design
//   PAYPAL_CLIENT_SECRET  - server only
//   PAYPAL_ENV            - "sandbox" (default) or "live"
//   PAYPAL_WEBHOOK_ID     - the id PayPal gives when you register the webhook
//   PAYPAL_PLAN_STARTER / PAYPAL_PLAN_PRO / PAYPAL_PLAN_DESK - plan ids (P-...)
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

/** Plan ids, keyed by our own plan code. Missing ones are simply absent. */
export function planIds(): Partial<Record<PlanCode, string>> {
  const out: Partial<Record<PlanCode, string>> = {};
  for (const code of PLAN_CODES) {
    const id = Deno.env.get(`PAYPAL_PLAN_${code.toUpperCase()}`);
    if (id) out[code] = id;
  }
  return out;
}

export function planCodeFor(planId: string): PlanCode | null {
  for (const [code, id] of Object.entries(planIds())) {
    if (id === planId) return code as PlanCode;
  }
  return null;
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
