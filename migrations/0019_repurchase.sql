-- Phase 18: Repurchase with previous specifications (Mode A: same specs,
-- Mode B: customized finals) on the SAME PasarGuard user.
--
-- SAFETY DESIGN (deliberate, follows the 0015 precedent):
-- 0015 documents that the hot `orders` table cannot be rebuilt under live FKs
-- to extend a table CHECK. This migration therefore does NOT touch the
-- `orders.kind` CHECK ('purchase','renewal') and does NOT rebuild `orders`.
-- Repurchase rows reuse kind='renewal' and are distinguished by the new
-- `repurchase_mode` column ('same' | 'custom', NULL = historical renewal or
-- purchase) plus `snapshot.kind='repurchase'` in selections. Every renewal
-- write path keeps working on historical rows; every repurchase query
-- requires `repurchase_mode IS NOT NULL`, and the renewal guards exclude
-- repurchase rows explicitly. A future CHECK extension (with a proper
-- FK-safe procedure) may re-label these rows to kind='repurchase'.
--
-- Purely additive otherwise:
-- 1) Five claimed-target columns on repurchase rows, set BEFORE any panel
--    mutation so retries converge instead of re-applying (same "claim then
--    act" discipline as renew_target_unix from 0006 / quota target from 0018).
-- 2) conversation_states rebuild: ADD the five WAITING_REPURCHASE_* states to
--    the CHECK list (SQLite cannot ALTER a CHECK in place — identical rebuild
--    discipline to 0006/0017/0018). All pre-existing states — INCLUDING the
--    WAITING_RENEWAL_* states — are preserved verbatim so in-flight renewal
--    sessions/orders drain safely instead of violating the constraint.
-- 3) Partial index for the one-active-repurchase guard.
-- 4) `repurchase` settings document (kill switch). No existing rows altered.

ALTER TABLE orders ADD COLUMN repurchase_mode TEXT
  CHECK (repurchase_mode IS NULL OR repurchase_mode IN ('same', 'custom'));

-- Claimed ABSOLUTE panel quota target (bytes) for the repurchase finals.
-- Mode A: original volume_gb * GB_BYTES. Mode B: selected volume_gb * GB_BYTES.
-- Absolute final quota, never an additive delta.
ALTER TABLE orders ADD COLUMN repurchase_target_quota_bytes INTEGER;

-- Claimed ABSOLUTE fresh expiry target (unix seconds), base = repurchase time.
ALTER TABLE orders ADD COLUMN repurchase_target_unix INTEGER;

-- Claimed final HWID/device limit for the repurchase finals.
ALTER TABLE orders ADD COLUMN repurchase_target_hwid INTEGER;

-- Claimed reset-usage proof: 1 once POST .../by-username/{u}/reset has been
-- issued for this order. Retries adopt instead of re-resetting blindly; the
-- panel GET (used_traffic == 0) is the authoritative proof.
ALTER TABLE orders ADD COLUMN repurchase_reset_done INTEGER NOT NULL DEFAULT 0
  CHECK (repurchase_reset_done IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_orders_repurchases
  ON orders (renews_order_id)
  WHERE repurchase_mode IS NOT NULL;

CREATE TABLE conversation_states_new (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT',
                'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_VOLUME',
                'WAITING_RENEWAL_CONFIRMATION',
                'WAITING_REPURCHASE_MODE', 'WAITING_REPURCHASE_VOLUME',
                'WAITING_REPURCHASE_DURATION', 'WAITING_REPURCHASE_DEVICE',
                'WAITING_REPURCHASE_CONFIRMATION',
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

-- Repurchase policy as a versioned settings document (kill switch). Malformed
-- or missing doc = repurchases unavailable (fail closed, like renewal).
-- Seeded DISABLED on purpose: applying this migration must never auto-enable
-- the feature — it is enabled explicitly later, after verification.
INSERT OR IGNORE INTO settings (key, value) VALUES ('repurchase', '{"schema":1,"enabled":false,"near_expiry_days":7}');
