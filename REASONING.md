# Reasoning

## Data model
Three tables: `users` (owner login), `customers` (one row per subscriber, with a
`status` of `active`/`paused`), and `pause_periods` (a history row per pause, with
`resumed_on` left `NULL` while the pause is still open). Keeping pause history as its
own table — rather than just a `paused_since` field on the customer — means a
customer's whole pause/resume history survives across months, which the billing
calculation needs (a customer might have paused and resumed twice within one month).

## Billing logic — the core design decision
The spec deliberately leaves "pro-rated for days actually delivered" open to
interpretation. I made these calls, in order of importance:

1. **Only weekdays (Mon–Fri) count as delivery days.** Weekends are never billed,
   whether or not the customer is paused — tiffin services generally don't deliver
   on weekends, and pausing "over a weekend" shouldn't cost or save the customer
   anything.
2. **`resumed_on` is a delivered day, not a paused one.** If someone pauses on the
   10th and resumes on the 15th, the 15th counts as served. This felt more intuitive
   than treating resume-day as still-paused, and matches how a customer would describe
   it ("I'm back from the 15th").
3. **An open-ended pause (no resume yet) is billed up to *today*, clipped to month-end.**
   This lets the owner still generate a bill mid-month for someone who's currently
   paused, without it counting the rest of the month (which hasn't happened yet) as
   also paused.
4. **Formula:** `bill = planPrice × (deliveredWeekdays / totalWeekdaysInMonth)`. A flat
   per-day rate derived from the plan price, rather than a hardcoded "30 days" divisor,
   so it stays fair across months with 20 vs. 23 weekdays.

## Testing approach
Tested `computeBill` directly with hand-picked cases before wiring up the API:
- No pauses at all → full plan price.
- A pause fully inside one month → bill drops proportionally.
- A pause spanning a month boundary → only the days inside the queried month count.
- An open pause (no resume) queried for the current month → clipped to today.
- Two separate pause periods in the same month → both subtracted correctly.
- A weekend-only "pause" → no billing impact (since weekends were never counted).

Then exercised the same scenarios through the actual REST endpoints (subscribe →
pause → resume → bill) to confirm the DB round-trip matched the pure-function results.

## What I'd fix with more time
- Pause/resume dates are currently free-text (`YYYY-MM-DD`); a date picker on the
  frontend would prevent malformed input.
- No validation yet that `resumed_on` is after `paused_from` at the DB layer — this
  is checked implicitly by the pause/resume flow (you can't resume without an open
  pause) but a direct bad API call could still insert an inconsistent row.

## Later additions

### Multi-tenancy (`owner_id`)
The original schema let any logged-in owner see every customer in the
database, which only works if there's ever exactly one tiffin owner using the
app. I added an `owner_id` column to `customers` (referencing `users`) and a
composite `UNIQUE(owner_id, phone)` constraint instead of a bare unique phone,
so two different owners can each have a customer with the same phone number,
but the same owner can't add the same phone twice. Every route in
`customers.js` now filters by `owner_id = req.user.userId` (via a small
`getOwnedCustomer` helper), so one owner can never read, bill, pause, or
export another owner's data — this is the difference between a toy demo and
something that could actually be handed to more than one tiffin business.
`db.js` checks for the column and `ALTER TABLE`s it in if it's missing, so
upgrading doesn't require deleting an existing `tiffin.db`.

### Centralized validation instead of ad-hoc `if` checks
Moved input checks (name/phone/planPrice on subscribe, date format on
pause/resume, year/month range on the bill and CSV endpoints) into
`validate.js`. This isn't a new library — just one place that returns
`{ valid, errors }` — but it means every route reports errors the same way
instead of each route inventing its own checks inline.

### Analytics + CSV export
The spec only asks for a per-customer bill, but a tiffin owner's actual
month-end task is "what do I collect from everyone." `GET
/api/customers/stats/summary` reuses `computeBill` across every customer to
give a live active/paused count and an estimated total for the current
month, shown as a doughnut chart on the dashboard. `GET
/api/customers/export.csv` runs the same per-customer calculation and streams
it back as a downloadable CSV — one request that answers "what does everyone
owe this month," instead of clicking "Bill" on each customer one at a time.

### Security & operability middleware
Added `helmet` (security headers/CSP), `cors`, `compression`, `morgan` request
logging, and `express-rate-limit` on `/api/auth` (20 attempts / 15 minutes /
IP) to cut down on credential-stuffing against login. None of this changes
the app's behavior for a legitimate user — it's the difference between code
that works on localhost and code that isn't obviously unsafe to actually
deploy. Added a centralized Express error handler + JSON 404 for unmatched
`/api` routes so an unexpected DB error returns clean JSON instead of an HTML
stack trace or a crashed process.

### API documentation
Wrote `openapi.yaml` (OpenAPI 3.0) covering every endpoint and serve it as
interactive Swagger UI at `/api-docs`, in addition to the endpoint table in
`README.md`. The two aren't meant to duplicate effort — the README table is
the quick reference, `/api-docs` is for actually trying a request (including
auth) from the browser.

### Automated tests for the billing engine
`billing.js` is pure functions with no DB dependency, which is exactly the
part of this app that's easiest to get subtly wrong (off-by-one on the resume
day, weekend handling, month-boundary clipping) and hardest to catch by
clicking through the UI. `tests/billing.test.js` uses Node's built-in
`node:test` runner (no extra dependency) to automate the exact scenarios
listed under "Testing approach" above, so they run on every change instead of
being re-checked by hand.

### Switching from `better-sqlite3` to `node:sqlite`
Originally used `better-sqlite3`, a native addon that has to compile C++
code during `npm install`. On a machine without the Visual Studio C++ build
tools (common on a fresh Windows setup), that install fails outright. Since
Node 24 ships a built-in `node:sqlite` module with an API deliberately close
to `better-sqlite3`'s (`db.exec()`, `db.prepare().run()/.get()/.all()`, the
same `{ changes, lastInsertRowid }` shape from `.run()`), swapping to it
removed the native-compilation step entirely — `npm install` now only
installs pure-JavaScript packages. The only code changes were in `db.js`:
the import (`require('node:sqlite')` instead of `require('better-sqlite3')`)
and replacing `db.pragma('journal_mode = WAL')` (a `better-sqlite3`
convenience method with no `node:sqlite` equivalent) with the equivalent
plain SQL, `db.exec('PRAGMA journal_mode = WAL;')`. Every other file
(`customers.js`, `auth.js`, `billing.js`) was untouched, which is the point
of the two libraries sharing an API shape.

### A bug I introduced, and the actual fix
Adding `helmet`'s Content-Security-Policy (see "Security & operability
middleware" above) silently broke every page, because `login.html`,
`register.html`, and `dashboard.html` originally had their JavaScript
written inline in a `<script>...</script>` block right inside the HTML,
and `dashboard.html` also had two `onclick="..."` attributes (Log out,
Close). A CSP `script-src` that doesn't explicitly allow `'unsafe-inline'`
blocks both of those silently — no console error in some cases, the
handler just never attaches — so clicking "Create account" did a bare,
do-nothing HTML form submission instead of calling the API. The fix was
not to weaken the CSP (adding `'unsafe-inline'` back would defeat the point
of having it), but to do what the policy expects: every page's script now
lives in its own file (`public/js/login.js`, `register.js`, `dashboard.js`),
loaded with `<script src="...">`, and the two `onclick` attributes became
`addEventListener` calls in `dashboard.js`. `style-src` still allows
`'unsafe-inline'`, since the pages' inline `style=""` attributes are much
lower-risk than inline script and weren't worth restructuring into a
stylesheet for a project this size.


## Assessment twist implementation

### T1 — Notification Service clock/outbox
The morning notification requirement is implemented as a small internal Notification Service module rather than a fake external SMS integration. `POST /clock` is a deterministic grading hook and also has the canonical `/api/notifications/clock` route. It checks weekdays, active status and open pause periods, then persists one outbox message per customer/day. The database uniqueness constraint makes the clock idempotent, so repeated calls are safe. `GET /outbox` exposes the durable queue for evaluation.

### T6 — Mid-cycle transfer lifecycle
A transfer is modeled as an explicit `subscription_transfers` record linking the old and new customer identities. The new identity inherits `plan_price` and `cycle_start`; the old identity points at the new identity and is excluded from the default current roster, preserving history. Billing uses the transfer effective date as a hard service boundary: weekdays before it belong to the old identity and weekdays from it belong to the new identity. Pause history is still applied independently to each identity. This avoids double-counting a delivery day.

### T4 — Messy customer import
The import path deliberately avoids requiring a heavy ETL dependency. It accepts either raw CSV or JSON rows, normalizes header spelling/case, canonicalizes common Indian phone formats, parses several common date formats, and returns a transparent `{ imported, deduped, rejected }` report with row-level details. Duplicate phones are deterministic and never silently overwrite existing subscriptions. Invalid rows are rejected rather than partially persisted.

## Frontend redesign
The original functional UI was retained conceptually but redesigned as a responsive product UI: premium typography, layered cards, animated hero, subtle hover/micro-interactions, modal transitions, responsive grids, reduced-motion support, and an operations dashboard for all three assessment twists. The dashboard intentionally uses the same REST APIs as the evaluator, so the visual redesign does not bypass the full-stack requirements.

## Verification
Static verification was run with `node --check` across the modified server and browser JavaScript files, and the existing nine billing tests pass directly with `node --test tests/billing.test.js`. Dependency installation was attempted in the isolated build environment but the package registry did not complete before the execution timeout, so a full Express integration boot could not be executed in this environment. The project remains dependency-compatible with its existing `package.json`; on Codespaces, run `npm install`, `npm test`, then `npm start` and check `/health`.
