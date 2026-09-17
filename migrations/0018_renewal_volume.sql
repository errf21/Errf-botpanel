-- Renewal / service-increase: additive volume alongside duration.
-- 1) Claimed absolute panel quota target (bytes) on a renewal order, set
--    BEFORE the panel PUT so retries converge instead of re-adding
--    (same "claim then act" discipline as renew_target_unix from 0006).
-- 2) conversation_states rebuild: add WAITING_RENEWAL_VOLUME to the CHECK
--    list (SQLite cannot ALTER a CHECK in place — identical rebuild
--    discipline to 0006/0017). All pre-existing states preserved verbatim.
-- Purely additive: no existing rows/columns/constraints altered otherwise.
-- NOT applied to production by this change (file only).

ALTER TABLE orders ADD COLUMN renew_target_data_limit_bytes INTEGER;

CREATE TABLE conversation_states_new (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN (
                'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
                'WAITING_DURATION', 'WAITING_DEVICE_LIMIT',
                'WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT',
                'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_VOLUME',
                'WAITING_RENEWAL_CONFIRMATION',
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
