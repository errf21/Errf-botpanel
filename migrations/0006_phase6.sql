-- Phase 6: My Services + status + renewals.
-- Additive against orders; ONE constrained rebuild for conversation_states
-- (SQLite cannot extend a CHECK list in place) — same columns, extended enum.
-- Panel-side extension is done with absolute `expire` targets, so a renewal
-- order carries its claimed target (idempotent retries, same discipline as
-- the username claim in 0001/0005).

-- Order kind: purchase = creates a service, renewal = extends one.
ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'purchase'
  CHECK (kind IN ('purchase', 'renewal'));

-- The purchase order (service) a renewal extends. No FK: orders reference
-- themselves from a different row-set and soft linkage preserves history.
ALTER TABLE orders ADD COLUMN renews_order_id TEXT;

-- Authoritative local expiry of a service (purchase row), maintained at
-- provisioning + each applied renewal. Display falls back to it when the
-- panel is unreachable.
ALTER TABLE orders ADD COLUMN service_expires_at TEXT;

-- Claimed absolute extension target (unix seconds) on a renewal order, set
-- BEFORE the panel PUT so retries converge instead of stacking.
ALTER TABLE orders ADD COLUMN renew_target_unix INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_renews ON orders(renews_order_id);

-- conversation_states rebuild: add the two renewal states to the CHECK list.
CREATE TABLE conversation_states_new (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT',
                'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_CONFIRMATION'
              )),
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  expires_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO conversation_states_new (customer_id, state, data, expires_at, updated_at)
  SELECT customer_id, state, data, expires_at, updated_at FROM conversation_states;

DROP TABLE conversation_states;
ALTER TABLE conversation_states_new RENAME TO conversation_states;

-- Business decision: duration is months-only (1/2/3). The catalog layer stays
-- day-based (wire/provisioning units unchanged); presets now map to whole
-- months and custom durations are OFF. Admins may edit/re-enable via D1.
UPDATE settings SET value = '{
  "schema": 1,
  "min_days": 30,
  "max_days": 90,
  "allow_custom": false,
  "presets": [
    { "days": 30, "enabled": true },
    { "days": 60, "enabled": true },
    { "days": 90, "enabled": true }
  ]
}' WHERE key = 'duration_options';

-- Renewal policy as a versioned settings document (kill switch + future
-- knobs like early-renewal windows). Malformed doc = renewals unavailable.
INSERT OR IGNORE INTO settings (key, value) VALUES ('renewal', '{
  "schema": 1,
  "enabled": true,
  "near_expiry_days": 7
}');
