-- Phase 13B: sales/service stop switch.
-- A persistent admin-controlled flag in the `settings` config layer (the bot
-- never caches it in memory — every webhook reads it from D1, so it survives
-- restarts/redeploys). The switch means: TEMPORARY COMMERCIAL STOP of service
-- provisioning — new purchases AND renewals are blocked (e.g. the PasarGuard
-- panel/template capacity may be exhausted), while everything concerning
-- EXISTING services keeps working (detail, status, subscription pages,
-- payment/approval of orders created before the stop, support, wallet,
-- announcements, admin surfaces).
--
-- FAIL-OPEN contract (loader src/catalog/sales.ts): a missing row, invalid
-- JSON or a wrong schema all mean sales ENABLED; only an explicit
-- "stopped": true blocks provisioning. Admin toggles route through
-- src/db/sales.ts (CAS + settings_audit).

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('sales', '{"schema":1,"stopped":false}');

UPDATE settings
   SET updated_by = 'migration:0013',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'sales' AND updated_by IS NULL;
