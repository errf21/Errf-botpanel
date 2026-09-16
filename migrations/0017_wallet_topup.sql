-- Phase 17: customer wallet top-up (additive only).
-- New dedicated `wallet_topups` request table + 'topup_credit' ledger kind +
-- two conversation states. No existing rows/columns/indexes/constraints are
-- altered except the two CHECK-list extensions (SQLite cannot ALTER a CHECK in
-- place — identical rebuild discipline to 0006/0007/0011/0014/0016).
-- Top-ups never touch `orders`/`order_events`: they affect only
-- wallet_topups + wallet_entries(kind='topup_credit') + customers.balance_irt.

-- 1) Dedicated top-up requests. `id` is the durable unique identity and the
--    wallet_entries.order_id the approval credit carries (exactly-once key).
--    `idempotency_key` mirrors the orders pattern: the session token minted at
--    top-up entry, so a retried amount submit can never create two rows.
CREATE TABLE IF NOT EXISTS wallet_topups (
  id                TEXT PRIMARY KEY, -- ULID (newOrderId())
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  amount_irt        INTEGER NOT NULL CHECK (amount_irt >= 45000),
  state             TEXT NOT NULL DEFAULT 'await_amount'
                    CHECK (state IN ('await_amount', 'await_receipt', 'pending_review', 'approved', 'rejected')),
  receipt_file_id   TEXT,
  receipt_kind      TEXT CHECK (receipt_kind IS NULL OR receipt_kind IN ('photo', 'document')),
  payment_reference TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  reviewed_by       TEXT, -- 'admin:<telegram_id>'
  reviewed_at       TEXT,
  reject_reason     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_topups_customer
  ON wallet_topups(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_wallet_topups_state
  ON wallet_topups(state, created_at);

-- 2) wallet_entries rebuild: add 'topup_credit' to the kind CHECK.
--    Column-for-column identical to 0007; every existing row survives verbatim.
CREATE TABLE wallet_entries_new (
  id            TEXT PRIMARY KEY, -- ULID
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  delta_irt     INTEGER NOT NULL CHECK (delta_irt != 0),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'referral_reward', 'admin_grant', 'admin_debit',
                  'order_payment', 'order_refund', 'topup_credit'
                )),
  order_id      TEXT,             -- top-up id for 'topup_credit' entries
  actor         TEXT NOT NULL,    -- 'system' | 'admin:<id>' | 'customer'
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO wallet_entries_new (id, customer_id, delta_irt, kind, order_id, actor, balance_after, created_at)
  SELECT id, customer_id, delta_irt, kind, order_id, actor, balance_after, created_at FROM wallet_entries;

DROP TABLE wallet_entries;
ALTER TABLE wallet_entries_new RENAME TO wallet_entries;

CREATE INDEX IF NOT EXISTS idx_wallet_entries_customer
  ON wallet_entries(customer_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_payment_once
  ON wallet_entries(order_id) WHERE kind = 'order_payment';

-- Hard backstop for the top-up credit claim: one 'topup_credit' ledger row
-- per top-up id; concurrent approvals can never both book a credit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topup_once
  ON wallet_entries(order_id) WHERE kind = 'topup_credit';

-- 3) conversation_states rebuild: add the two top-up states to the CHECK list.
--    All 13 pre-existing states preserved verbatim.
CREATE TABLE conversation_states_new (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT',
                'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_CONFIRMATION',
                'WAITING_SUPPORT_MESSAGE',
                'WAITING_ANNOUNCE_TEXT', 'WAITING_ANNOUNCE_CONFIRM',
                'WAITING_TOPUP_AMOUNT', 'WAITING_TOPUP_RECEIPT'
              )),
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  expires_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO conversation_states_new (customer_id, state, data, expires_at, updated_at)
  SELECT customer_id, state, data, expires_at, updated_at FROM conversation_states;

DROP TABLE conversation_states;
ALTER TABLE conversation_states_new RENAME TO conversation_states;

-- 4) admin_actions rebuild: add the 'topup_reject' arming kind for the
--    top-up reject-reason prompt (order_id stays NULL, target_id = top-up id —
--    same shape as support_reply/wallet kinds). All existing rows preserved.
CREATE TABLE admin_actions_new (
  admin_user_id TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN (
                  'reject', 'support_reply', 'wallet_grant', 'wallet_debit',
                  'pricing', 'topup_reject'
                )),
  target_id     TEXT, -- ticket id / telegram user id / pricing edit token / top-up id
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);

INSERT INTO admin_actions_new (admin_user_id, order_id, action, target_id, created_at, expires_at)
  SELECT admin_user_id, order_id, action, target_id, created_at, expires_at FROM admin_actions;

DROP TABLE admin_actions;
ALTER TABLE admin_actions_new RENAME TO admin_actions;
