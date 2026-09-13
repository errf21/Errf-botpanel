-- Phase 7: support tickets + referrals + wallet + announcements.
-- Additive against 0001-0006; ONE constrained rebuild each for
-- conversation_states (extended enum) and admin_actions (SQLite cannot
-- extend a CHECK list in place) — same shape rules as 0006.
-- Money stays integer IRT everywhere; the ledger, not a cached balance, is
-- the audit truth (customers.balance_irt is the atomic spendable counter).

ALTER TABLE customers ADD COLUMN balance_irt INTEGER NOT NULL DEFAULT 0
  CHECK (balance_irt >= 0);

-- Structural anti-abuse guard: a referee is written exactly once, ever
-- (the guarded UPDATE uses WHERE referred_by IS NULL; the row itself is the
-- single attribution record). Multi-referral per referrer is allowed but
-- payout-capped via the `referral` settings doc + referral_rewards PK.
ALTER TABLE customers ADD COLUMN referred_by INTEGER;
ALTER TABLE customers ADD COLUMN referral_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_referral_code
  ON customers(referral_code) WHERE referral_code IS NOT NULL;

-- Wallet ledger: append-only. Every balance mutation writes one row whose
-- balance_after must equal customers.balance_irt at commit time (batched).
CREATE TABLE IF NOT EXISTS wallet_entries (
  id            TEXT PRIMARY KEY, -- ULID
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  delta_irt     INTEGER NOT NULL CHECK (delta_irt != 0),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'referral_reward', 'admin_grant', 'admin_debit',
                  'order_payment', 'order_refund'
                )),
  order_id      TEXT,             -- soft link for payment/refund entries
  actor         TEXT NOT NULL,    -- 'system' | 'admin:<id>' | 'customer'
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_entries_customer
  ON wallet_entries(customer_id, created_at);

-- Hard backstop for the wallet payment claim: one 'order_payment' ledger row
-- per order id (draft token at claim time, re-pointed to the real order id
-- once created); concurrent claims can never both book a payment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_payment_once
  ON wallet_entries(order_id) WHERE kind = 'order_payment';

-- Exactly-one payout per referred customer (PK = the referee).
CREATE TABLE IF NOT EXISTS referral_rewards (
  referred_customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
  referrer_customer_id  INTEGER NOT NULL REFERENCES customers(id),
  order_id              TEXT NOT NULL,
  amount_irt            INTEGER NOT NULL CHECK (amount_irt > 0),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer
  ON referral_rewards(referrer_customer_id);

-- Support: one open ticket per customer at a time (partial UNIQUE).
CREATE TABLE IF NOT EXISTS support_tickets (
  id          TEXT PRIMARY KEY, -- ULID
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  state       TEXT NOT NULL DEFAULT 'open'
              CHECK (state IN ('open', 'answered', 'closed')),
  subject     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_open_per_customer
  ON support_tickets(customer_id) WHERE state IN ('open', 'answered');

CREATE INDEX IF NOT EXISTS idx_tickets_state ON support_tickets(state, updated_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id         TEXT PRIMARY KEY, -- ULID
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,    -- 'customer' | 'admin:<telegram_id>'
  body       TEXT NOT NULL,
  file_id    TEXT,             -- optional receipt-style attachment
  file_kind  TEXT CHECK (file_id IS NULL OR file_kind IN ('photo', 'document')),
  delivered  INTEGER NOT NULL DEFAULT 1 CHECK (delivered IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
  ON support_messages(ticket_id, created_at);

-- Announcements: durable publish job + per-recipient delivery rows.
-- UNIQUE(announcement_id, customer_id) is the double-send guard: chunked
-- resumes insert-or-skip, so nobody can ever receive the same notice twice.
CREATE TABLE IF NOT EXISTS announcements (
  id              TEXT PRIMARY KEY, -- ULID
  body            TEXT NOT NULL,
  created_by      TEXT NOT NULL,    -- 'admin:<telegram_id>'
  state           TEXT NOT NULL DEFAULT 'sending'
                  CHECK (state IN ('sending', 'done')),
  total_estimate  INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS announcement_deliveries (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (announcement_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_announce_deliveries_pending
  ON announcement_deliveries(announcement_id, status);

-- conversation_states rebuild: add the three Phase 7 states to the CHECK list.
CREATE TABLE conversation_states_new (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT',
                'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_CONFIRMATION',
                'WAITING_SUPPORT_MESSAGE',
                'WAITING_ANNOUNCE_TEXT', 'WAITING_ANNOUNCE_CONFIRM'
              )),
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  expires_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO conversation_states_new (customer_id, state, data, expires_at, updated_at)
  SELECT customer_id, state, data, expires_at, updated_at FROM conversation_states;

DROP TABLE conversation_states;
ALTER TABLE conversation_states_new RENAME TO conversation_states;

-- admin_actions rebuild: besides 'reject', it can now arm a support reply or
-- a grant/debit lookup keyed by ticket id or target telegram user id.
CREATE TABLE admin_actions_new (
  admin_user_id TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN (
                  'reject', 'support_reply', 'wallet_grant', 'wallet_debit'
                )),
  target_id     TEXT, -- ticket id (support_reply) / telegram user id (grant/debit)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);

INSERT INTO admin_actions_new (admin_user_id, order_id, action, created_at, expires_at)
  SELECT admin_user_id, order_id, action, created_at, expires_at FROM admin_actions;

DROP TABLE admin_actions;
ALTER TABLE admin_actions_new RENAME TO admin_actions;

-- Wallet + referral policies as versioned settings docs (degrade-safe loaders
-- in src/catalog/{wallet,referral}.ts). Amounts are integer TOMAN (IRT).
INSERT OR IGNORE INTO settings (key, value) VALUES ('wallet', '{
  "schema": 1,
  "enabled": true,
  "max_credit_irt": 500000000,
  "max_debit_irt": 500000000
}');

-- Referral reward: an integer PERCENT (1-100) of the referee's first
-- approved purchase total (order amount + wallet credit, server-side only),
-- floored to whole IRT. One payout per referee, lifetime-capped per referrer.
INSERT OR IGNORE INTO settings (key, value) VALUES ('referral', '{
  "schema": 1,
  "enabled": true,
  "reward_percent": 10,
  "max_rewards_per_referrer": 20
}');
