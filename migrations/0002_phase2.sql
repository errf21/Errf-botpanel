-- Phase 2: persistent conversation state + webhook update dedupe.
-- Additive only; 0001_init.sql remains untouched.

CREATE TABLE IF NOT EXISTS conversation_states (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT'
              )),
  -- Draft selections/context as JSON; Phase 3+ extends the payload, not the engine.
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  expires_at  TEXT, -- idle sessions expire (24h, enforced lazily on read)
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Webhook replay/duplicate protection: Telegram redelivers on slow/error responses.
CREATE TABLE IF NOT EXISTS update_dedupe (
  update_id   INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_update_dedupe_received
  ON update_dedupe(received_at);
