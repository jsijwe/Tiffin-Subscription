const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// ---------------------------------------------------------------------
// Uses Node's BUILT-IN SQLite module (node:sqlite), stable since Node 24.
// This avoids the better-sqlite3 native addon entirely, so there's
// nothing to compile and no Visual Studio / build-tools requirement on
// Windows. Its API (db.exec, db.prepare().run()/.get()/.all()) is
// deliberately close to better-sqlite3's, which is why the rest of this
// project barely had to change.
//
// Requires Node >= 22. On Node 22-23 it's still experimental and needs
// the server started with `node --experimental-sqlite server/index.js`;
// on Node 24+ (what this project was built and tested against) it just
// works with no flag.
// ---------------------------------------------------------------------
const db = new DatabaseSync(path.join(__dirname, '..', 'tiffin.db'));

// node:sqlite has no .pragma() helper like better-sqlite3 — pragmas are
// just executed as plain SQL.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------
// Schema
//   users          -> owner accounts (registration/login)
//   customers      -> one row per tiffin subscriber
//   pause_periods  -> history of pause/resume windows per customer;
//                     resumed_on = NULL means "still paused"
// ---------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- owner_id makes this multi-tenant: each tiffin owner only ever sees
  -- and bills their own customers, even though everyone shares one DB file.
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    plan_price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cycle_start TEXT,
    transfer_to_customer_id INTEGER REFERENCES customers(id),
    UNIQUE(owner_id, phone)
  );

  CREATE TABLE IF NOT EXISTS pause_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    paused_from TEXT NOT NULL,
    resumed_on TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_id);
  CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
  CREATE INDEX IF NOT EXISTS idx_pause_customer ON pause_periods(customer_id);

  CREATE TABLE IF NOT EXISTS subscription_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    to_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    effective_on TEXT NOT NULL,
    plan_price REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_customer_id)
  );

  CREATE TABLE IF NOT EXISTS notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    delivery_date TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'sms',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(customer_id, delivery_date)
  );
`);

// ---------------------------------------------------------------------
// Lightweight migration: if this file already exists from an earlier,
// single-tenant version of the schema (no owner_id column), add it so
// upgrading doesn't require deleting tiffin.db.
// ---------------------------------------------------------------------
const columns = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
if (!columns.includes('owner_id')) {
  db.exec(`ALTER TABLE customers ADD COLUMN owner_id INTEGER REFERENCES users(id)`);
}
if (!columns.includes('cycle_start')) {
  db.exec('ALTER TABLE customers ADD COLUMN cycle_start TEXT');
  db.exec("UPDATE customers SET cycle_start = substr(created_at, 1, 10) WHERE cycle_start IS NULL");
}
if (!columns.includes('transfer_to_customer_id')) {
  db.exec('ALTER TABLE customers ADD COLUMN transfer_to_customer_id INTEGER REFERENCES customers(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_customers_transfer ON customers(transfer_to_customer_id)');

module.exports = db;
