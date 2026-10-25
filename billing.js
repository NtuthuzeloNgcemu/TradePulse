/* -----------------------------------------------
   TradePulse - billing (PayPal subscriptions)

   The browser never decides what plan someone is on. It asks the server what
   PayPal is configured with, renders PayPal's own buttons, and tells the
   server which subscription PayPal approved. The server re-reads that
   subscription from PayPal before it writes anything down.

   PayPal cannot charge in ZAR, so plans are charged in the currency the
   PayPal plan was created in (USD), shown beside the Rand price.
----------------------------------------------- */

const TP_PLAN_NAMES = { starter: "Starter", pro: "Pro", desk: "Desk" };
const TP_PLAN_ZAR = { starter: "R299", pro: "R799", desk: "R2,499" };

const TP_STATUS_COPY = {
  approval_pending: "Waiting for you to approve it at PayPal.",
  approved: "Approved at PayPal. It becomes active on the first payment.",
  active: "Active.",
  suspended: "Suspended by PayPal, usually after a failed payment.",
  cancelled: "Cancelled. You keep access until the end of the paid period.",
  expired: "Expired.",
};

const tpBilling = {
  config: null,
  sdkLoaded: false,

  async call(body) {
    const { data, error } = await tpClient.functions.invoke("paypal-subscription", { body });
    if (error) {
      // Supabase wraps the function's own message; surface it when we can.
      let message = "Couldn't reach the billing service.";
      try {
        const parsed = await error.context?.json?.();
        if (parsed?.error) message = parsed.error;
      } catch { /* keep the generic message */ }
      throw new Error(message);
    }
    return data;
  },

  /** Loads PayPal's SDK once, for the client id the server gave us. */
  loadSdk(clientId) {
    if (this.sdkLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&vault=true&intent=subscription`;
      el.onload = () => {
        // A blocked request can still fire onload with an empty body, so the
        // SDK counts as loaded only once it has actually defined itself.
        if (!window.paypal?.Buttons) {
          reject(new Error("PayPal's script loaded but didn't start."));
          return;
        }
        this.sdkLoaded = true;
        resolve();
      };
      el.onerror = () => reject(new Error("PayPal's script didn't load."));
      document.head.appendChild(el);
    });
  },

  price(plan) {
    if (!plan.amount || !plan.currency) return "price unavailable";
    return `${plan.currency} ${plan.amount} / month`;
  },
};

async function tpRenderBilling() {
  const stateEl = document.getElementById("billingState");
  const plansEl = document.getElementById("billingPlans");
  const statusEl = document.getElementById("billingStatus");
  if (!stateEl || !plansEl) return;

  const fail = (message) => {
    stateEl.classList.remove("is-loading");
    stateEl.textContent = message;
    plansEl.hidden = true;
  };

  let config;
  let current = null;
  try {
    config = await tpBilling.call({ action: "config" });
  } catch (e) {
    fail(`${e.message} Your account is unaffected.`);
    return;
  }

  if (!config?.configured) {
    stateEl.classList.remove("is-loading");
    stateEl.innerHTML = 'Payments aren\'t switched on yet, so you aren\'t being charged. Plans and prices are on the <a href="pricing.html">Pricing page</a>.';
    return;
  }

  try {
    const result = await tpBilling.call({ action: "refresh" });
    current = result?.subscription || null;
  } catch {
    // A subscription we couldn't re-read is not the same as not having one.
    fail("Couldn't check your subscription with PayPal just now. Try again shortly — nothing has changed.");
    return;
  }

  tpBilling.config = config;
  stateEl.classList.remove("is-loading");

  const sandbox = config.environment === "sandbox"
    ? '<p class="billing-sandbox">Test mode. These are PayPal sandbox payments — no real money moves.</p>'
    : "";

  // ---- already subscribed ----
  if (current && ["approval_pending", "approved", "active", "suspended"].includes(current.status)) {
    const name = TP_PLAN_NAMES[current.plan_code] || current.plan_code;
    const amount = current.amount ? `${current.currency} ${current.amount}` : "amount not yet charged";
    const renews = current.current_period_end
      ? `Next payment ${new Date(current.current_period_end).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}.`
      : "";
    stateEl.innerHTML = `${sandbox}
      <p><strong>${name}</strong> — ${TP_STATUS_COPY[current.status] || current.status}</p>
      <p>${amount} per month. ${renews}</p>
      <p class="billing-ref">PayPal subscription ${current.provider_subscription_id}</p>`;
    plansEl.hidden = false;
    plansEl.innerHTML = '<button class="button button-paper button-small" type="button" id="cancelSubscription">Cancel subscription</button>';
    document.getElementById("cancelSubscription").addEventListener("click", async () => {
      if (!window.confirm("Cancel this subscription at PayPal? You keep access until the end of the period you've paid for.")) return;
      statusEl.textContent = "Cancelling…";
      try {
        await tpBilling.call({ action: "cancel" });
        statusEl.textContent = "Cancelled at PayPal.";
        tpRenderBilling();
      } catch (e) {
        statusEl.textContent = e.message;
      }
    });
    return;
  }

  // ---- configured, but nothing to sell yet ----
  // The plans have to exist at PayPal before anyone can subscribe. Rather than
  // creating them by hand in a terminal, the project owner creates them from
  // here; the server checks who is asking before it does anything.
  if (!config.plans?.length) {
    stateEl.innerHTML = `${sandbox}<p>PayPal is connected, but no plans have been created yet, so there is nothing to subscribe to.</p>`;
    plansEl.hidden = false;
    plansEl.innerHTML = '<button class="button button-paper button-small" type="button" id="setupPlans">Create the plans at PayPal</button>';
    document.getElementById("setupPlans").addEventListener("click", async (e) => {
      e.target.disabled = true;
      statusEl.textContent = "Asking PayPal to create the product, plans and webhook\u2026";
      try {
        const result = await tpBilling.call({ action: "setup" });
        statusEl.innerHTML = `<strong>${result.environment}</strong><br>${(result.done || []).join("<br>")}`;
        setTimeout(tpRenderBilling, 2500);
      } catch (err) {
        statusEl.textContent = err.message;
        e.target.disabled = false;
      }
    });
    return;
  }

  const wasCancelled = current && ["cancelled", "expired"].includes(current.status)
    ? `<p>Your previous ${TP_PLAN_NAMES[current.plan_code] || current.plan_code} subscription is ${current.status}.</p>`
    : "";
  stateEl.innerHTML = `${sandbox}${wasCancelled}<p>You aren't subscribed. Pick a plan to subscribe through PayPal.</p>`;

  plansEl.hidden = false;
  plansEl.innerHTML = config.plans.map((plan) => `
    <div class="billing-plan">
      <div>
        <strong>${TP_PLAN_NAMES[plan.code] || plan.code}</strong>
        <span>${tpBilling.price(plan)}${TP_PLAN_ZAR[plan.code] ? ` · listed at ${TP_PLAN_ZAR[plan.code]}` : ""}</span>
      </div>
      <div class="billing-buttons" id="paypal-${plan.code}"></div>
    </div>`).join("");

  try {
    await tpBilling.loadSdk(config.client_id);
  } catch (e) {
    // Ad and tracker blockers block paypal.com routinely, so this is a state
    // the page has to handle, not an exception to let escape.
    statusEl.textContent = `${e.message} A privacy blocker or extension is the usual cause. Allow paypal.com and reload. You haven't been charged.`;
    plansEl.hidden = true;
    return;
  }

  for (const plan of config.plans) {
    try {
      window.paypal.Buttons({
        style: { layout: "horizontal", height: 40, tagline: false },
        createSubscription: (data, actions) => actions.subscription.create({
          plan_id: plan.plan_id,
          // Lets a webhook that arrives before the browser does still find the
          // right account.
          custom_id: tpBilling.userId || undefined,
        }),
        onApprove: async (data) => {
          statusEl.textContent = "Confirming with PayPal…";
          try {
            await tpBilling.call({ action: "claim", subscription_id: data.subscriptionID });
            statusEl.textContent = "Subscribed.";
            tpRenderBilling();
          } catch (e) {
            statusEl.textContent = `${e.message} Your PayPal subscription id is ${data.subscriptionID} — keep it if you need support.`;
          }
        },
        onError: () => {
          statusEl.textContent = "PayPal reported a problem. Nothing was charged.";
        },
      }).render(`#paypal-${plan.code}`);
    } catch {
      const slot = document.getElementById(`paypal-${plan.code}`);
      if (slot) slot.textContent = "PayPal's button couldn't be shown for this plan.";
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!document.getElementById("billingState")) return;
  const { data } = await tpClient.auth.getUser();
  tpBilling.userId = data?.user?.id || null;
  tpRenderBilling();
});
