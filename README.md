# TradePulse

A trading journal that only shows what your own records support. Static HTML, CSS and vanilla JavaScript, with Supabase for accounts, database, file storage and server functions. There is no build step.

## Run locally

```
npx serve .
```

Open the address it prints. For sign-up confirmation and password reset to work locally, add that address to Supabase Auth > URL Configuration (Site URL and Redirect URLs).

## Tests

```
npm install
npm test
```

Node's built-in runner (Node 22.6+ for the TypeScript test). Covers the CSV parser, the analytics formulas and the AI extraction helpers. Fixtures in `tests/fixtures/` are test data only and must never be loaded into a real account.

## Layout

| File | Purpose |
|---|---|
| `index.html`, `pricing.html`, legal pages | Public site |
| `login.html`, `register.html`, `reset-password.html` | Accounts |
| `dashboard.html` | Overview |
| `journal.html` + `journal.js` | Trade list and editor |
| `analytics.html` + `analytics-page.js` | Metrics and breakdowns |
| `insights.html` + `insights-page.js` | Calculated observations |
| `playbook.html` + `playbook.js` | Rules and AI suggestions |
| `account.html` + `account.js` | Profile, export, deletion |
| `dashboard.js` | Shared app shell, uploads, review, data loading (`window.TP`) |
| `trade-parser.js` | CSV and AI row parsing rules (pure, tested) |
| `analytics.js` | All metric formulas (pure, tested) |
| `motion.js` | Spring engine, momentum projection, rubber-banding (pure, tested) |
| `interactions.js` | Sheets, drag-to-dismiss, the drawer gesture, scroll edge |
| `vendor/` | Pinned copies of Supabase and Papa Parse |
| `supabase/migrations/` | Database schema and security rules |
| `supabase/functions/` | Server functions (AI reading, account deletion) |
| `_headers` | Security headers for Netlify or Cloudflare Pages |

## Rules the product keeps

1. Nothing user-specific appears without a source the user provided.
2. Imported and AI-extracted rows are shown for review; only what the user confirms is saved.
3. Values that could mean more than one thing are flagged, never guessed.
4. Every trade records where it came from, and every metric shows its sample size.
5. AI output is a suggestion with its source text attached, never a fact.
6. A failed query shows an error, never an empty account.

## Motion

Anything a person can touch is animated with a spring from `motion.js`, never a CSS transition, so it can be grabbed and reversed mid-flight. Springs are described with bounce and duration: bounce `0` (critically damped) is the default, and bounce is only added where a gesture carried momentum. Gestures track 1:1, resist at boundaries, and hand their release velocity to the spring.

`prefers-reduced-motion` is handled inside `Spring.to()`, which snaps instead of animating, so every component gets it without extra code.

## CSV import rules

- A row needs an instrument, plus at least one of: R result, entry price, exit price.
- R comes only from a column named R, R multiple or Result (R). A trailing `R` is accepted. Result, Profit or P/L columns are never read as R.
- `1,5` and other comma numbers are flagged, never converted. So are percentages.
- ISO and `YYYY.MM.DD HH:MM` dates are accepted. Slash dates only when the file proves the order.
- Files with repeated column names (MT4/MT5 statements) are refused with a reason.

## AI reading

`supabase/functions/process-source` sends one file to Groq when the user asks. It needs a `GROQ_API_KEY` secret on the Supabase project (Settings > Edge Functions > Secrets). Without it, the app says AI reading isn't set up. Optional `GROQ_TEXT_MODEL` and `GROQ_VISION_MODEL` override the defaults.

## Signing up

A new account is confirmed with a **six-digit code**, not only a link. A link has to land on a URL the Supabase project is configured to allow, which is one more thing to get wrong and does not work at all before the site is hosted. A code works wherever the person already is.

**This needs one setting.** In Supabase, go to Authentication > Emails > **Confirm signup** and make sure the template includes `{{ .Token }}`. Without it the email carries only a link and there is no code to type. The link still works and still activates the account.

Entering a correct code signs the person in, so they go straight to the app rather than back to a login form. The code screen also offers a resend, which locks for a minute afterwards because Supabase rate-limits them.

Supabase answers a mistyped code and an expired one with the same message, so the app does not claim to know which it was.

## Plans

Three tiers. **Free** is the default: an account with no live subscription is on it, which is a state, not an error.

| | Free | Pro | Desk |
| --- | --- | --- | --- |
| Trades | 30 | unlimited | unlimited |
| Manual entry, CSV import | yes | yes | yes |
| Analytics | yes | yes | yes |
| Insights | no | yes | yes |
| AI file reading | no | yes | yes |
| Team features | no | no | planned |

### Where each limit is actually enforced

A limit that only exists in JavaScript is a suggestion, so each one lives where it cannot be bypassed:

- **Trade cap:** a `before insert` trigger on `trades`, because trades are inserted straight from the browser under RLS. Hitting it raises `trade_limit_reached`, which the app turns into a sentence.
- **AI reading:** inside `process-source`, which checks `current_plan()` before it spends anything. Hiding the button would not stop a direct call.
- **Insights:** the interface only. The observations are calculated in the browser from trades the person already owns, so this one cannot be made airtight without moving the maths off the device. It is a plan boundary, not a secret.

`current_plan(uid)` is the single source of truth: it reads `subscriptions`, prefers the highest live plan, and returns `free` when there is none. The browser may call it and cannot change the answer. When it can't be read, the app assumes free — the assumption that promises least.

Free is not sold through PayPal and Desk is arranged directly, so Pro is the only tier with a PayPal plan behind it.

## Payments (PayPal subscriptions)

PayPal has no ZAR. South African merchants receive into a USD, EUR or GBP balance and withdraw to Rands through FNB, so the plans are **charged in the currency the PayPal plan was created in** (USD), with the Rand price shown beside it as the listed price. A South African provider for ZAR debit orders is planned separately.

Nothing is charged until the secrets below are set. Without them the account page says payments aren't switched on, which is the honest state, not an error.

### Secrets (Supabase > Settings > Edge Functions > Secrets)

| Secret | What it is |
| --- | --- |
| `PAYPAL_CLIENT_ID` | From the PayPal Developer dashboard. Public: it is sent to the browser. |
| `PAYPAL_CLIENT_SECRET` | Server only. Never in the repo or the browser. |
| `PAYPAL_ENV` | `sandbox` (default) or `live`. |
| `PAYPAL_SETUP_EMAIL` | The one account allowed to create plans from the app. |

That is all. The PayPal product, the plans and the webhook are **created by the
app itself**: sign in as `PAYPAL_SETUP_EMAIL`, open Account > Billing and press
"Create the plans at PayPal". Their ids are stored in `billing_plans` and
`billing_provider_settings`, not in secrets, so no terminal is needed and there
is nothing to copy by hand.

Setup is safe to run twice: an existing product, plan or webhook is reused and
reported, never replaced. A plan's price is fixed by PayPal once created, so
changing a price means creating a new plan.

`PAYPAL_WEBHOOK_ID` is still read if set, as an override for a webhook that was
registered by hand.

### How it fits together

- `supabase/functions/paypal-subscription` — `config` tells the browser which plans exist and what PayPal will actually charge (read from PayPal, not from our own copy); `claim` re-reads an approved subscription from PayPal before storing it; `refresh` and `cancel` do what they say.
- `supabase/functions/paypal-webhook` — PayPal's notifications. Deploy with `--no-verify-jwt`: PayPal is not a signed-in user, and authenticity comes from PayPal's own signature verification instead. Every delivery is recorded in `billing_webhook_events` by PayPal's event id before it is applied, so a retry can't apply the same event twice.
- `billing.js` + the Billing section of `account.html` — the only place a subscription can be started or cancelled.

The browser never decides entitlement. `subscriptions` has a select policy and no insert, update or delete policy, so RLS denies writes to the browser entirely and only the service role can grant a plan.

### Testing in the sandbox

Set `PAYPAL_ENV=sandbox` and use sandbox credentials. The account page labels itself "Test mode" whenever the environment is sandbox. Pay with a sandbox personal account; no real money moves.

## Deploying

Any static host serves this folder. On Netlify or Cloudflare Pages, `_headers` is picked up automatically; elsewhere, copy those headers into the host's config. Update `connect-src` in `_headers` if the Supabase project changes. The `paypal.com` and `paypalobjects.com` entries there are what let the PayPal buttons load.
