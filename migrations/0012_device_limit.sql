-- Phase 13A: user/device purchase limit.
-- Business decision: the purchasable user count is now 1–3 via fixed presets.
-- This supersedes the 0003 ladder document (min 1, max 10, custom typing ON).
-- The pricing document (0011, approved model) is NOT touched: its user_prices
-- keys 4..10 simply become unreachable — the ladder sells {1,2,3} only, every
-- one of which is priced, so loadCatalog's coverage check stays satisfied.
-- Duration/volume ladder documents are untouched (1/2/3 months remains).

UPDATE settings SET value = '{
  "schema": 1,
  "min_count": 1,
  "max_count": 3,
  "allow_custom": false,
  "presets": [
    { "count": 1, "enabled": true },
    { "count": 2, "enabled": true },
    { "count": 3, "enabled": true }
  ]
}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'migration:0012'
WHERE key = 'device_options';
