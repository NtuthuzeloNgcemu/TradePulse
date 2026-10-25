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

## Deploying

Any static host serves this folder. On Netlify or Cloudflare Pages, `_headers` is picked up automatically; elsewhere, copy those headers into the host's config. Update `connect-src` in `_headers` if the Supabase project changes.
