# TiffinBook — Tiffin Subscription Operations & Pro-Rated Billing

A full-stack, multi-tenant app for home-style tiffin (lunch delivery) services:
each owner subscribes their own customers, pauses/resumes their service around
travel or festivals, and generates an accurate pro-rated bill for any month
based only on the days a customer was actually served.

## Tech stack
- **Backend:** Node.js + Express
- **Database:** SQLite via Node's **built-in** `node:sqlite` module (stable since Node 24, experimental with a flag on Node 22-23) — real relational persistence, multi-tenant schema, and no native addon to compile (no Visual Studio / build-tools needed on Windows, unlike `better-sqlite3`)
- **Auth:** JWT (issued on register/login), bcrypt-hashed passwords, rate-limited login/register
- **Security & platform middleware:** `helmet` (security headers/CSP), `cors`, `compression`, `morgan` (request logging), `express-rate-limit`
- **API docs:** OpenAPI 3.0 spec (`openapi.yaml`) served as interactive Swagger UI at `/api-docs`
- **Testing:** automated unit tests for the billing/pro-ration logic using Node's built-in `node:test` runner (no extra test framework dependency)
- **Frontend:** Plain HTML/CSS/JS (no build step, no framework) with a responsive premium UI, CSS motion, micro-interactions and Chart.js (via CDN)
- **Config:** `dotenv` for environment variables

## Setup & run

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (override with `PORT=xxxx npm start`,
or copy `.env.example` to `.env` and edit it). A SQLite file `tiffin.db` is
created automatically in the project root on first run — no separate DB setup
needed. If you're upgrading an older copy of this project, the schema
migrates itself (adds the new `owner_id` column) the first time it starts —
no need to delete your existing `tiffin.db`.

Open `http://localhost:3000` in a browser:
1. Click **Get started** to register an owner account.
2. You'll land on the dashboard — add a customer, pause/resume, calculate bills,
   transfer a live subscription, import a messy CSV, and run the morning delivery clock.
3. Visit `http://localhost:3000/api-docs` for interactive API documentation
   (click "Authorize" and paste your token to try authenticated endpoints
   directly from the browser).

### Environment variables (see `.env.example`)
| Variable     | Default                | Purpose                                |
|--------------|-------------------------|------------------------------------------|
| `PORT`       | `3000`                  | HTTP port                               |
| `JWT_SECRET` | `dev-secret-change-me`  | Signing secret for auth tokens — **change this before deploying** |
| `NODE_ENV`   | `development`           | Switches Morgan's log format to `combined` in production |

### Running the tests
```bash
npm test
```
Runs `tests/billing.test.js` against the pro-ration engine: no pauses, a pause
fully inside the month, a pause spanning a month boundary, an open (unresumed)
pause clipped to "today", two pauses in one month, and a weekend-only pause
that has zero billing impact.

### Requirements
- **Node.js 22.5+** (Node 24+ strongly recommended). This project uses Node's
  built-in `node:sqlite` module instead of an external database driver, so
  there's nothing to compile — `npm install` should never need Visual
  Studio, Python, or any C++ build tools.
- On Node 22 or 23, `node:sqlite` is still experimental, so start the server
  with the flag instead: `node --experimental-sqlite server/index.js`
  (or `npx --node-options=--experimental-sqlite npm start`). On Node 24+,
  no flag is needed — `npm start` just works.

### Debugging
- Delete `tiffin.db` (and the `-wal`/`-shm` files next to it) to reset all data —
  the schema recreates itself on next start.
- `GET /health` returns `{ ok: true, dbFileExists: true }` if the server is up.
- All API errors return JSON `{ error: "..." }` with an appropriate status code;
  unexpected errors are caught by a centralized error handler instead of
  crashing the process or leaking a stack trace.
- If you see `SQLite is not supported in this Node.js build` or a `require`
  error for `node:sqlite`, your Node version is too old — upgrade to 22.5+
  (24+ recommended) via nodejs.org or a version manager like `nvm`/`nvm-windows`.

## API endpoints

All `/api/customers/*` routes require `Authorization: Bearer <token>` (token comes
back from register/login) and are **scoped to the logged-in owner** — one
owner never sees or bills another owner's customers, even though they share
one database file. Full interactive documentation (with request/response
schemas) is at `/api-docs` once the server is running; the table below is the
quick reference.

| Method | Path                           | Purpose                                                          |
|--------|---------------------------------|-------------------------------------------------------------------|
| POST   | `/api/auth/register`           | Create an owner account → `{ token, email }` (rate-limited)      |
| POST   | `/api/auth/login`              | Log in → `{ token, email }` (rate-limited)                       |
| POST   | `/api/customers`                | Subscribe a new customer `{ name, phone, planPrice }`             |
| GET    | `/api/customers`                | List customers — supports `search`, `status`, `sortBy`, `order`, `page`, `pageSize` |
| GET    | `/api/customers/stats/summary`  | Dashboard analytics: total/active/paused counts + this month's estimated revenue |
| GET    | `/api/customers/export.csv`     | Download a CSV of every customer's bill for a given month (`year`, `month`) |
| GET    | `/api/customers/phone/:phone`   | Look up a customer by phone number                                |
| GET    | `/api/customers/:id`            | Get one customer + their pause history                            |
| POST   | `/api/customers/:id/pause`      | Pause a customer, optional `{ from: "YYYY-MM-DD" }`                |
| POST   | `/api/customers/:id/resume`     | Resume a customer, optional `{ to: "YYYY-MM-DD" }`                 |
| GET    | `/api/customers/:id/bill`       | Pro-rated bill — query params `year`, `month` (defaults to current month) |
| GET    | `/health`                       | Health check                                                       |

## Project structure

```
server/
  index.js       — Express app entry: security middleware, rate limiting,
                    Swagger docs, centralized error handling
  db.js          — SQLite schema + connection + self-migration
  auth.js        — register/login + JWT middleware
  validate.js    — shared input-validation helpers
  billing.js     — pro-ration math (pure functions, no DB dependency, unit-tested)
  customers.js   — customer subscriptions, search/sort/pagination, pause/resume, billing, import and transfers
  notifications.js — morning delivery clock + durable notification outbox
tests/
  billing.test.js — unit tests for the pro-ration engine (node:test)
public/
  index.html      — landing page
  login.html / register.html — auth pages
  dashboard.html  — premium animated operations UI: analytics, search/sort/paginate,
                    subscribe, pause/resume, bill, transfer, CSV import/export and notifications
  css/styles.css
  js/app.js       — shared frontend auth/fetch/download helpers
openapi.yaml       — OpenAPI 3.0 spec, served as Swagger UI at /api-docs
.env.example        — documented environment variables
```

See `REASONING.md` for the billing assumptions, the multi-tenancy decision,
and other design trade-offs.

## Quick twist checks

After login, the dashboard exposes all three twist workflows. A ready-to-test messy CSV is included at `sample-data/messy-customers.csv`. The raw HTTP hooks are also deterministic:

```bash
# queue today
curl -X POST http://localhost:3000/clock -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{}"

# inspect the queue
curl http://localhost:3000/outbox -H "Authorization: Bearer $TOKEN"

# import a CSV
curl -X POST http://localhost:3000/api/customers/import -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" --data-binary @sample-data/messy-customers.csv
```

## Assessment twists implemented

### Level 1 — T1 (integrate): Notification Service
`POST /clock` (and `/api/notifications/clock`) checks the requested/current date. On a
weekday it queues one reminder for each active customer who is not currently paused.
The queue is persisted in `notification_outbox` and is idempotent per customer/day,
so repeated clock calls do not create duplicate notifications. `GET /outbox` exposes the
queue for deterministic grading without needing an external SMS provider.

### Level 2 — T6 (lifecycle): Mid-cycle subscription transfer
`POST /api/customers/:id/transfer` creates the new customer identity while copying the
plan price and `cycle_start`. `effectiveOn` is the handover boundary. The original identity
is hidden from the current roster, while history remains queryable. Bills for the transfer
month split served weekdays before the boundary to the old identity and served weekdays
from the boundary to the new identity.

### Level 3 — T4 (messy data): Clean customer import
`POST /api/customers/import` accepts a JSON row array or raw CSV. It normalizes common
header names, Indian 10/12-digit phone formats, and common date formats including
`YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY` and `DD-MM-YYYY`. Duplicate phones are
reported as `deduped`; rows missing a name/phone/positive price are `rejected`; valid
rows are persisted and counted as `imported`.
