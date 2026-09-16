-- Phase 15b: free-test usage + quota-exhausted notices (isolated kinds).
--
-- Additive against 0001-0015, plus ONE constrained leaf-table rebuild of
-- service_notifications to extend its kind CHECK list (SQLite cannot alter a
-- CHECK in place — identical discipline to 0006/0007/0011/0014). No incoming
-- FKs reference this table, so the rebuild is self-contained.
--
-- Design notes:
--  * Paid services keep the 'usage90' + 'expiring' set EXACTLY unchanged
--    (their candidate SQL excludes claimed test orders); the two new kinds
--    are test-only (EXISTS on free_test_claims) with their own per-run
--    budgets, so the normal pools are never shared or starved.
--  * 'free_test_usage90' fires once at >=90% of the live panel quota
--    (100 MB SI → 90_000_000 bytes); 'free_test_exhausted' fires once at
--    used >= limit. Distinct PK rows → independent once-only state, same
--    lease/claim/book mechanics as every other kind.
--  * No deploy-day backfill: both kinds start empty by construction, and
--    already-expired test services are never polled for quota (expiry guard).

-- service_notifications rebuild: add the two test-usage kinds.
-- Column-for-column identical to 0014; every existing row survives verbatim.
CREATE TABLE service_notifications_new (
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('usage90','expiring','free_test_expiring','free_test_usage90','free_test_exhausted')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','skipped','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 64),
  last_checked_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (order_id, kind)
);

INSERT INTO service_notifications_new (
  order_id, kind, status, attempts, last_checked_at, created_at, updated_at
)
SELECT order_id, kind, status, attempts, last_checked_at, created_at, updated_at
  FROM service_notifications;

DROP TABLE service_notifications;
ALTER TABLE service_notifications_new RENAME TO service_notifications;
