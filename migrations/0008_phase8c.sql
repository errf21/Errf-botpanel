-- Phase 8C: payment review reminders.
-- Fully additive; 0001-0007 untouched. One schedule row per order whose
-- receipt entered the review queue; the cron sweep advances `reminded_stage`
-- through a single guarded UPDATE per stage (15/30/45 min after the FIRST
-- receipt submission). Replacement receipts never re-anchor (the INSERT OR
-- IGNORE loses to this PK), so an order has exactly one schedule, ever.
CREATE TABLE IF NOT EXISTS payment_reminders (
  order_id       TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reminded_stage INTEGER NOT NULL DEFAULT 0 CHECK (reminded_stage BETWEEN 0 AND 3)
);

-- Backfill orders already awaiting_review at deploy time. The anchor is the
-- first real 'receipt_uploaded' event (fallback: orders.updated_at) and the
-- stage is seeded from the ELAPSED time, so a 60-min-old pending order does
-- NOT get three nudges spammed at it on release day.
INSERT OR IGNORE INTO payment_reminders (order_id, created_at, reminded_stage)
SELECT
  o.id,
  anchor.ts,
  -- MIN(3, MAX(0, floor(elapsed_minutes / 15))) — SQLite has no boolean-cast
  -- shortcut, so clamp with CASE.
  CASE
    WHEN (julianday('now') - julianday(anchor.ts)) * 1440.0 / 15.0 >= 3
      THEN 3
    WHEN CAST((julianday('now') - julianday(anchor.ts)) * 1440.0 / 15.0 AS INTEGER) <= 0
      THEN 0
    ELSE CAST((julianday('now') - julianday(anchor.ts)) * 1440.0 / 15.0 AS INTEGER)
  END
FROM orders o
JOIN (
  SELECT
    o2.id AS oid,
    COALESCE(
      (SELECT MIN(e.created_at) FROM order_events e
        WHERE e.order_id = o2.id AND e.action = 'receipt_uploaded'),
      o2.updated_at
    ) AS ts
  FROM orders o2
) anchor ON anchor.oid = o.id
WHERE o.state = 'awaiting_review';
