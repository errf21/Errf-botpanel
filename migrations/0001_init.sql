-- Phase 1 foundation schema for telbotv2 (Cloudflare D1 / SQLite).
-- Business options/prices are NOT hardcoded: they live in `settings` as JSON.

CREATE TABLE IF NOT EXISTS customers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  first_name       TEXT,
  last_name        TEXT,
  language_code    TEXT,
  is_admin         INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY, -- ULID, unique + sortable
  customer_id          INTEGER NOT NULL REFERENCES customers(id),
  state                TEXT NOT NULL DEFAULT 'pending_payment' CHECK (state IN (
                         'pending_payment', 'awaiting_review', 'approved',
                         'provisioning', 'completed', 'rejected', 'failed', 'cancelled'
                       )),
  -- Purchase selections as JSON (volume/duration/devices), driven by `settings`.
  selections           TEXT NOT NULL CHECK (json_valid(selections)),
  amount               INTEGER NOT NULL CHECK (amount >= 0),
  currency             TEXT NOT NULL DEFAULT 'IRR',
  -- Payment evidence / references (populated in Phase 4).
  receipt_file_id      TEXT,
  payment_reference    TEXT,
  verified_by          TEXT,
  verified_at          TEXT,
  -- Provisioning safety (used in Phase 5). UNIQUE = duplicate-creation guard;
  -- NULL allowed until provisioned, one service can never link two orders.
  pasarguard_username  TEXT UNIQUE,
  pasarguard_user_id   TEXT UNIQUE,
  service_created_at   TEXT,
  failure_reason       TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_state    ON orders(state);

-- Immutable audit trail: every state transition and admin action.
CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL, -- 'customer' | 'admin:<telegram_id>' | 'system'
  action     TEXT NOT NULL, -- e.g. 'state_change', 'receipt_uploaded', 'payment_rejected'
  from_state TEXT,
  to_state   TEXT,
  data       TEXT,          -- optional JSON payload (CHECK can't allow NULL + json_valid together cleanly)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

-- Centralized business configuration (NOT business logic):
-- volume/duration/device options, prices, payment instructions, etc.
-- Values are JSON documents; edited without redeploying the bot.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT
);

-- Empty default containers so the config layer exists from day one.
-- Actual options/prices are seeded/edited in Phase 3 — none here.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('volume_options',  '[]'),
  ('duration_options','[]'),
  ('device_options',  '[]'),
  ('pricing',         '{}'),
  ('payment_info',    '{}'),
  ('business_settings', '{}');
