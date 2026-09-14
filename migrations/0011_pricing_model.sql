-- Phase 12: admin pricing model.
-- Replaces the OBSOLETE draft (0011_pricing_admin.sql, never applied) with a
-- design built for the NEW business model:
--
--   total = time + volume + users
--     time    = months == 1 ? base_product.price : duration_prices[months]
--     volume  = max(0, volume_gb - base_product.gb) * price_per_gb
--     users   = user_prices[device_count]
--
-- `pricing` becomes a schema-2 settings document. duration_prices / user_prices
-- are EXACT admin-defined entries (no multipliers, no months*rates arithmetic);
-- the ladder documents (volume/duration/device_options) are NOT touched here —
-- the seeded user_prices simply cover the currently configured device range
-- (presets {1,3,5}, min 1, max 10), so the purchasable set is unchanged.
--
-- Additive against 0001-0010 (none rewritten), plus ONE constrained rebuild of
-- admin_actions to extend its CHECK list (SQLite cannot alter a CHECK in
-- place) — identical shape rules as 0006/0007.

-- 1) Rebuild admin_actions: add the 'pricing' action kind.
--    'pricing' arming carries only target_id (pricing field + staged value),
--    order_id stays NULL, exactly as the Phase 7 support_reply/wallet kinds.
CREATE TABLE admin_actions_new (
  admin_user_id TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN (
                  'reject', 'support_reply', 'wallet_grant', 'wallet_debit',
                  'pricing'
                )),
  target_id     TEXT, -- ticket id / telegram user id / pricing edit token
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);

INSERT INTO admin_actions_new (admin_user_id, order_id, action, target_id, created_at, expires_at)
  SELECT admin_user_id, order_id, action, target_id, created_at, expires_at FROM admin_actions;

DROP TABLE admin_actions;
ALTER TABLE admin_actions_new RENAME TO admin_actions;

-- 2) Audit trail for live settings edits. This CANNOT reuse order_events (its
--    order_id is a NOT NULL FK to orders; a settings edit belongs to no order),
--    and the settings row itself only keeps the LAST editor. Append-only:
--    nothing updates or deletes these rows. Pricing edits store the FULL
--    before/after document, so any old order price can be re-explained from
--    the audit chain alone.
CREATE TABLE IF NOT EXISTS settings_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,             -- 'pricing' (future config keys may join)
  actor      TEXT NOT NULL,             -- 'admin:<telegram_user_id>' — verified sender only
  action     TEXT NOT NULL,             -- edited field token: 'base' | 'gb' | 'd<m>' | 'u<n>'
  old_value  TEXT NOT NULL CHECK (json_valid(old_value)),   -- full pre-edit document
  new_value  TEXT NOT NULL CHECK (json_valid(new_value)),   -- full post-edit document
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_key ON settings_audit(key, created_at);

-- 3) The pricing document itself: schema 2 (parser src/catalog/catalog.ts).
--    NOTE: every number below is a PLACEHOLDER; the admin edits them live via
--    /pricing (armed, confirmed, audited) — never a redeploy.
--      time:     1m -> base_product.price; 2m/3m -> duration_prices "2"/"3"
--                (independent numbers on purpose: 2m is NOT 2x1m).
--      volume:   beyond base_product.gb (10) -> price_per_gb each.
--      users:    user_prices by count; '1' is 0 (a user beyond the first is
--                what the ladder charges); keys cover the CURRENT device
--                ladder {1,3,5} AND its custom range [1..10] (allow_custom on
--                in device_options means every count in range must be priced).
--    days_per_month stays: it is only the days<->months unit bridge the
--    catalog (which is day-based) needs; it carries no pricing meaning.
--    base_product.users/months are DECLARATIONS of what the base price
--    includes (the pricing rule hard-wires 1 month / 1 user to it); 'gb' is
--    live: the 10GB base volume uses it.
UPDATE settings SET
  value = '{
    "schema": 2,
    "currency": "IRT",
    "days_per_month": 30,
    "base_product": { "gb": 10, "users": 1, "months": 1, "price": 45000 },
    "price_per_gb": 4500,
    "duration_prices": { "2": 80000, "3": 110000 },
    "user_prices": {
      "1": 0,    "2": 25000,  "3": 50000,  "4": 75000,   "5": 100000,
      "6": 120000, "7": 140000, "8": 160000, "9": 180000, "10": 200000
    }
  }',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'migration:0011'
WHERE key = 'pricing';
