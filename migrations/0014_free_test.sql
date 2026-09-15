-- Phase 15: one-time free test service (100 MB / 1 day), once EVER per customer.
--
-- Additive against 0001-0013, plus ONE constrained leaf-table rebuild of
-- service_notifications to extend its kind CHECK list (SQLite cannot alter a
-- CHECK in place — identical discipline to 0006/0007/0011). No incoming FKs
-- reference this table (verified in 0001-0013), so the rebuild is self-contained.
--
-- Design notes:
--  * The test itself is an ordinary 'purchase' order (one dashboard: it is
--    listed, detailed and provisioned like any service), so the once-ever
--    promise must NOT lean on orders (no schema change there). It leans on
--    THIS table: customer_id is the PRIMARY KEY, so one claim row per
--    customer is a structural wall, not a code convention. The claim INSERT
--    loses the race cleanly (constraint violation => already claimed, ever).
--  * order_id is UNIQUE and carries the ULID minted at claim time BEFORE the
--    order row exists: an insert-crash between claim and order self-heals on
--    the next tap (recovery builds the order under the stored id — the order
--    PK/UNIQUE(idempotency_key) make that rebuild naturally deduped).
--  * Notifications: paid services keep the 'usage90' + 'expiring' set
--    EXACTLY unchanged (their candidate SQL excludes claimed test orders);
--    a test service gets instead exactly one 'free_test_expiring' notice
--    (~2h before expiry, same lease/PK once-only mechanics — see
--    src/{db,handlers}/serviceNotifications.ts). No deploy-day backfill is
--    needed for the new kind: free_test_claims starts empty by construction.

CREATE TABLE IF NOT EXISTS free_test_claims (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Free-test policy as a versioned settings document (parser
-- src/catalog/freeTest.ts, FAIL-CLOSED loader: missing/malformed/disabled
-- rows mean the test is simply unavailable — the opposite fail direction
-- from the sales switch, because this feature is an opt-on abuse surface).
INSERT OR IGNORE INTO settings (key, value) VALUES ('free_test', '{
  "schema": 1,
  "enabled": true,
  "volume_mb": 100,
  "duration_days": 1,
  "device_count": 1
}');

UPDATE settings
   SET updated_by = 'migration:0014',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'free_test' AND updated_by IS NULL;

-- service_notifications rebuild: add the 'free_test_expiring' kind.
-- Column-for-column identical to 0009; every existing row survives verbatim.
CREATE TABLE service_notifications_new (
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('usage90','expiring','free_test_expiring')),
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
