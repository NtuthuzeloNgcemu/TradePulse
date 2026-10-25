# Changes

## v26 (25 Oct 2026): PayPal subscriptions, in sandbox, set up without a terminal

Billing exists and is deployed. It is off until the PayPal secrets are set, and while `PAYPAL_ENV` is `sandbox` the account page says "Test mode" wherever money could move.

### The currency problem, stated plainly
PayPal does not support ZAR. South African merchants receive into USD, EUR or GBP and withdraw to Rands through FNB. So plans are charged in the currency their PayPal plan was created in (USD), and the pricing page now says so rather than implying R299 is what leaves your account. Stripe is not an option either: South Africa is in Stripe's "extended network", and Stripe's own country page sends it to Paystack. A ZAR provider is separate work and needs a registered company.

### Set up from the app, not a terminal
The first attempt had the owner creating the PayPal product, plans and webhook by hand with API calls. That is a lot of work to get wrong, so the app does it instead: sign in as `PAYPAL_SETUP_EMAIL`, open Account > Billing, press "Create the plans at PayPal". Four secrets, no commands.
- Plan ids and the webhook id live in `billing_plans` and `billing_provider_settings` rather than in secrets, so there is nothing to copy by hand.
- Running setup twice reuses what exists and says so. A plan's price is fixed by PayPal once created, so an existing plan is never silently replaced.
- Only the account named in `PAYPAL_SETUP_EMAIL` may run it; anyone else is refused.

### Entitlement is decided by the server
`subscriptions` has a select policy and deliberately no insert, update or delete policy, so RLS denies writes to the browser outright. Verified on the live database: `authenticated` has no insert or update on it, and the three server-only billing tables grant nothing to `anon` or `authenticated` at all. A forged request cannot buy itself a subscription.

- `paypal-subscription`: tells the browser which plans exist and what PayPal will charge, re-reads an approved subscription from PayPal before storing it, refreshes, cancels, and runs setup.
- `paypal-webhook`: verifies every delivery through PayPal's signature endpoint and records it by PayPal's event id before acting, so a retry can't be applied twice. Deployed without JWT verification, because PayPal is not a signed-in user.

### Honest states, not optimistic ones
- Secrets not set: "payments aren't switched on". Set but no plans: says exactly that, and offers to create them.
- PayPal unreachable when checking: says the check failed and nothing changed, rather than "not subscribed", which would invite a double purchase.
- A subscription already recorded against another account is refused, not moved.
- A PayPal state we don't recognise is recorded as unrecognised rather than mapped to a guess.

### Found while building
- The PayPal SDK can fire `onload` with an empty body, which is what an ad or privacy blocker does. That threw an uncaught error and left billing broken. It now detects it, names the likely cause, and says you haven't been charged.
- A parent-directory import does not survive edge-function deployment, so the shared PayPal helper is a copy inside each function, with a header saying to keep them identical.
- The security advisor caught the `updated_at` trigger function being callable directly over REST. Execute is now revoked from `anon` and `authenticated`.

### Still open
Live mode needs a PayPal business account and `PAYPAL_ENV=live`, which creates a fresh set of live plans. The Desk plan is still "talk to sales". Leaked-password protection is still off in Supabase Auth.

### Testing
40 unit tests, 73 end-to-end checks, 29 gesture checks and 28 billing checks pass.

## v25 (25 Oct 2026): only buttons look like buttons, and buttons are glass

### Nothing that isn't a control looks like one
Six things were drawn as pills with a border and a fill, which is the shape of a button. None of them do anything when pressed, so none of them are drawn that way any more:
- The three hero assurances are now plain text separated by a hairline.
- The date range above the metrics ("Trades from Jan 5 to Feb 5") is quiet text, not a bordered control.
- A file's status is a coloured dot and a word, so it reads as a state rather than an action.
- The "Most useful" plan marker on pricing and the plan note on the registration page are dotted labels.
- Two unused pill styles (`.rule-strip`, `.window-brand`) were deleted rather than left in the stylesheet.

### The hero is the illustration
The mock review window around it is gone, along with its heading and caption, which repeated what the hero copy already said. The illustration stays centred at the size it was. Its intrinsic size was also declared wrong in the markup (640x420 for a 960x960 image), which caused a layout shift as it loaded; that is fixed.

### Buttons are a material
Following the Apple design approach already used for the header and dialogs, buttons now tint and blur what passes behind them, with a bright top edge catching the light:
- Light buttons: 40% white, 20px blur, 180% saturation, a hairline edge and an inner white highlight.
- Dark buttons: 80% ink with the same blur, and a lighter inner top edge.
- The app's "Add" button and the sidebar collapse control match.

The rule against stacking one translucent surface on another is kept: buttons inside the dialog, the drill-down, the floating navigation bar and the cookie notice stay solid, because those surfaces are already glass.

Under `prefers-reduced-transparency` and `prefers-contrast: more` every glass button becomes a solid fill with a defined border and no blur. The contrast path is verified by test; reduced transparency mirrors it (no browser here can emulate that query).

### Also
Removed two arrow suffixes that v24 missed.

### Testing
40 unit tests, 73 end-to-end checks, 25 gesture checks and 9 single-file-bundle checks pass.

## v24 (25 Oct 2026): removing the generic design defaults

Ran the design against the tells in Anthropic's `frontend-design` skill. The palette, logo and typefaces are unchanged, as the handoff brief pins those down. What changed is the chrome that appeared regardless of subject.

### Labels
- Removed 20 tracked-out ALL-CAPS kickers that only restated the heading below them: the page-title eyebrows (the page name is already in the header and the sidebar), the empty-state kickers, the dialog kicker, and the marketing section labels (`PRODUCT`, `REVIEW LOOP`, `SIMPLE PRICING`, `QUESTIONS`, `WEEKLY CLARITY`, `LEGAL`).
- The labels that genuinely name a region (Activity, Next step, Input history, Review, Add a rule, Active rules, Where this came from) stayed, but are now quiet sentence-case labels in the body face rather than monospace caps.
- Every `text-transform: uppercase` is gone from the stylesheets. Table headers, status pills, group titles and the sidebar heading now read as words.

### Monospace
Kept for figures, where tabular numerals are doing real work. Removed from text labels, table headers, quote attributions and form labels, where it was decoration.

### Arrows and dot-joined meta
- Removed all 10 `→` suffixes. A link says where it goes without one.
- Meta strings now read as sentences ("Added 12 Oct. Read by AI: 4 trades to review") rather than fragments joined with middle dots.

### Card hierarchy
Everything used one radius and one shadow regardless of importance. Now there are three levels:
- Stat readings: flat tinted panels, no border, no shadow, 8px.
- Content cards: hairline border, no shadow, 12px.
- Things that actually float (dialogs, menus, drill-downs): elevation and a larger radius.

### Kept deliberately
The 01/02/03 markers on the Overview intro card. The skill warns that numbered markers are usually decoration, but Add → Review → Confirm is the product's real sequence, which is the case where they are appropriate.

### Not changed
Palette, logo, Instrument Serif and Inter, and all v23 motion and materials.

### Testing
40 unit tests, 73 end-to-end checks and 25 gesture checks still pass. Four animation assertions that used fixed waits now wait for the end state instead, which removes a flake that appeared under low frame rates.

## v23 (15 Oct 2026): fluid motion, materials and type

Applied Apple's fluid-interface approach (WWDC *Designing Fluid Interfaces*, *The Details of UI Typography*) to the app.

### New: a spring engine instead of CSS transitions (`motion.js`)
About 200 lines, no dependency, no build step. Anything a person can touch is now driven by a spring rather than a fixed-duration transition, because a spring always continues from the value currently on screen and carries its velocity through a change of target. That makes every animation grabbable and reversible mid-flight.
- Damping and response expressed as bounce and duration, as Apple and Motion both do. Critically damped by default; bounce only where a gesture carried momentum.
- Analytic solver, so motion is identical at 120, 60 or 30fps and survives a stalled tab.
- Momentum projection (the exponential-decay form iOS actually ships, not `v²/2a`), rubber-banding, and a velocity tracker that measures a real release speed from recent samples.
- 9 unit tests, including that a reversal mid-flight neither jumps nor loses velocity.

### New: gestures (`interactions.js`)
- **Sheets on phones.** The upload dialog and the trade editor rise from the bottom edge and can be dragged or thrown away. The backdrop fades continuously with the drag, not only at the end. Dragging up past the top resists instead of stopping dead. On release, the landing point is projected from velocity, so a flick throws it.
- **A grabbable navigation drawer.** It tracks the finger 1:1, resists past fully open, and closes on a flick. Direction of the throw decides the outcome, not where the finger happened to stop.
- **Dialogs grow from the control that opened them** (`transform-origin` set to the trigger) and dismiss back along the same path.
- Drag only starts after a 10px threshold and never from a button, so taps are never swallowed.

### Response and feedback
- Press feedback on pointer-down rather than release, across buttons, rows, nav links and the drawer handle.
- `touch-action: manipulation` to drop the legacy ~300ms tap delay.
- One short haptic, on a genuine import commit only.
- Only `transform` and `opacity` animate, with `will-change` set just before motion and released after.

### Materials and depth
- The app header is a translucent layer with content passing under it, replacing the opaque bar and its permanent divider.
- A scroll edge fade that appears only when content is actually underneath the header.
- Dialogs are a real material: blur, saturation and a bright top edge.
- The sidebar stays heavy and opaque, because it separates a structural region.

### Typography
- Size-specific tracking: tighter as type grows, slightly open at small sizes. A single `letter-spacing` is wrong somewhere.
- Tabular figures for every number, so results do not jitter as they change.
- Optical sizing enabled.

### Accessibility
- `prefers-reduced-motion`: springs snap, press feedback becomes a colour change rather than movement, the menu cross-fades. Verified by test, not just written.
- `prefers-reduced-transparency`: translucent surfaces become solid, blur is dropped.
- `prefers-contrast: more`: solid backgrounds with defined borders.

### Fixed while testing
- On phones the sheet's grab handle covered the close button, making it untappable.
- A closed drawer could still be reached by keyboard mid-animation.

### Testing
40 unit tests and 73 end-to-end checks still pass, plus 25 new browser checks covering throw-to-dismiss, tug-and-hold, flick-to-close, anchored origins, the scroll edge, and the reduced-motion path.

## v22 (14 Oct 2026): security, journal editing, analytics, insights, playbook, AI reading, account

### Database (applied to the live project; SQL in `supabase/migrations/`)
- A trade can only be linked to a file owned by the same user.
- The storage bucket now accepts only the file types the app uses.
- `sources` gained `file_size`, `file_hash`, `status_detail`, and AI fields (`extraction`, `extracted_by`, `extracted_at`). Only the server can write the AI fields.
- `playbook_rules` gained `origin` (user or ai), `source_id`, `evidence`, and the statuses `rejected` and `archived`. The browser can only create its own confirmed rules, and can't rewrite where a rule came from or move one back to "suggested".
- `insights` can only be written by the server.
- Removed permissions (TRUNCATE, REFERENCES, TRIGGER) the API never uses.
- Verified on the live database: 20 isolation checks passed, including that one user can't read or change another's trades, files or rules. The test rolled itself back.

### Server (Supabase Edge Functions)
- `process-source`: reads one stored file with AI (Groq) and saves what it found for review. Handles PDF (text), PNG/JPG (vision) and TXT. Treats the document as untrusted data, forbids calculation, validates every field, caps each extraction, limits each user to 25 reads a day, and sets an honest status with a reason on every failure. It never creates trades.
- `delete-account`: deletes the signed-in user's files and account after an explicit confirmation.

### App
- **Journal:** full trade list with search, and an editor on every trade to correct any field or delete it. Each trade shows where it came from (file, AI, or entered by hand) and what was left blank and why.
- **Sources:** each file can be reviewed, read with AI, downloaded or deleted. Deleting a file asks whether to delete the trades imported from it.
- **Duplicates:** uploading the same file twice is blocked by content hash. Identical rows within an import, or matching a trade you already have, are flagged for review rather than silently added.
- **AI reading:** shown as a clear choice per file, with what is sent and to whom, before anything leaves the browser. Results go through the same review screen as a CSV, with the AI's source quote beside each row.
- **Analytics:** definitions on the page, sample size and date range on every figure, breakdowns by setup, session, instrument and direction, groups under 10 trades marked, and drill-down to the underlying trades.
- **Insights:** calculated observations from your own trades, with evidence, win rates, dates and a stated limitation. Needs 20+ counted trades, 10+ on each side, and a 0.5R difference. No AI.
- **Playbook:** write rules, or accept, edit, reject or archive AI suggestions. Suggestions always show their source text and file.
- **Account page:** profile, password change, billing status, data export (CSV and JSON) and account deletion.
- **Password reset:** request a link from the login page, set a new password on `reset-password.html`.
- **Overview:** real activity and a next step based on actual unfinished work. The "start here" card disappears once there's data.

### Fixes from the audit
- The add button now works on phones (it was hidden below 600px).
- Registering with a short password now shows a message.
- The mobile drawer announces its state, closes on Escape, moves focus, and its links are no longer reachable while closed.
- Collapsed sidebar links keep their names and have tooltips, and the collapsed state is remembered.
- Settings moved out of the sidebar into the profile menu, which now has only working links.
- Two-column forms no longer overflow on narrow screens.
- The hidden cookie notice is no longer reachable by keyboard.
- Signing out in one tab now redirects other open tabs.
- Lists page past 1,000 rows instead of silently stopping.

### Launch prep
- The Supabase and Papa Parse libraries are now served from `vendor/` instead of a CDN, so the app can't receive an unexpected version.
- `_headers` adds a content security policy and related headers (read automatically by Netlify and Cloudflare Pages).
- Pricing, marketing and registration copy now describe only what works. Planned features are marked as planned, and there is no 14-day trial claim.
- Privacy, cookie and terms pages rewritten to match the real data flow, including the AI disclosure, where data is stored, and POPIA rights. **They are drafts and still need a South African lawyer's review.**
- Oversized images optimised: the landing page dropped from about 4.8 MB to about 0.4 MB.

### Still open
- Hosting and a domain, Google sign-in, a payment provider, and the legal review.
- Automatic broker sync, XLSX and DOCX reading, and team features.
- Leaked-password protection is a switch in Supabase (Auth > Password security).

## v21 (14 Oct 2026): Importer correctness and honest states
- CSV parser moved to `trade-parser.js` with no-guessing rules and tests.
- Review screen groups rows into ready, needs review and can't be imported, each with a reason.
- Failed queries show an error state instead of looking like an empty account.
- Files that aren't CSV are labelled "Stored, not processed".
- The upload dialog scrolls instead of cutting off its buttons.
