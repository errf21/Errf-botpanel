-- Phase 5: PasarGuard integration + automatic provisioning of approved orders.
-- Additive only; 0001-0004 untouched. The orders state enum (0001) already
-- allows 'provisioning'/'completed'/'failed', and pasarguard_username /
-- pasarguard_user_id UNIQUE columns (0001) are the DB-level duplicate-creation
-- guard used by this phase.

-- How many provisioning attempts an order has consumed (admin retry cap).
ALTER TABLE orders ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;

-- Subscription link returned by the panel on success (relative or absolute).
ALTER TABLE orders ADD COLUMN subscription_url TEXT;

-- Provisioning policy as a versioned settings document (like catalog/pricing):
-- the admin edits THIS row to change panel groups / retry caps — no redeploy.
-- group_ids below are the agreed purchase groups (24, 25).
INSERT OR IGNORE INTO settings (key, value) VALUES ('provisioning', '{
  "schema": 1,
  "enabled": true,
  "group_ids": [24, 25],
  "username_prefix": "pg",
  "max_attempts": 3,
  "default_status": "active"
}');
