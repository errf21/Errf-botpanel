-- Phase 3: order idempotency + catalog/pricing configuration documents.
-- Additive/UPDATE only against the `settings` config layer — 0001/0002 untouched.
-- NOTE: rates below are PLACEHOLDERS; the admin edits these same rows later
-- without any code changes.

ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency
  ON orders(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE settings SET value = '{
  "schema": 1,
  "min_gb": 10,
  "max_gb": 500,
  "allow_custom": true,
  "presets": [
    { "gb": 10,   "enabled": true },
    { "gb": 30,   "enabled": true },
    { "gb": 50,   "enabled": true },
    { "gb": 100,  "enabled": true },
    { "gb": 500,  "enabled": true }
  ]
}' WHERE key = 'volume_options';

UPDATE settings SET value = '{
  "schema": 1,
  "min_days": 5,
  "max_days": 365,
  "allow_custom": true,
  "presets": [
    { "days": 30,  "enabled": true },
    { "days": 90,  "enabled": true },
    { "days": 180, "enabled": true },
    { "days": 365, "enabled": true }
  ]
}' WHERE key = 'duration_options';

UPDATE settings SET value = '{
  "schema": 1,
  "min_count": 1,
  "max_count": 10,
  "allow_custom": true,
  "presets": [
    { "count": 1, "enabled": true },
    { "count": 3, "enabled": true },
    { "count": 5, "enabled": true }
  ]
}' WHERE key = 'device_options';

-- Integer linear pricing, currency in Toman (IRT):
--   total = GB * gb_rate
--         + ceil(days / days_per_month) * month_rate
--         + max(0, devices - 1) * device_rate
UPDATE settings SET value = '{
  "schema": 1,
  "currency": "IRT",
  "gb_rate": 12000,
  "month_rate": 120000,
  "device_rate": 60000,
  "days_per_month": 30
}' WHERE key = 'pricing';

UPDATE settings SET value = '{ "schema": 1 }' WHERE key = 'business_settings';
