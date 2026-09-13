-- Phase 9: service usage/expiry notifications.
-- Fully additive; 0001-0008 untouched. One row per (service order, kind) is
-- THE idempotency anchor: the composite PK can never hold two schedules for
-- one service, so "at most one usage90 notice and at most one expiring
-- notice per service/order, ever" is structural, not merely code-enforced.
-- Lifecycle: pending -> sending (atomic lease claim) -> sent
-- (Telegram confirmed) | skipped (terminal: nothing left to warn about,
-- e.g. the service is gone from the panel) | failed (terminal: the send
-- attempts cap was exhausted). Claim mechanics (lease window, caps, fused
-- eligibility) live in src/db/serviceNotifications.ts.
CREATE TABLE IF NOT EXISTS service_notifications (
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('usage90','expiring')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','skipped','failed')),
  -- Counted per WON claim that failed to deliver (Telegram-side sends only).
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 64),
  -- Panel-poll backoff: last time a usage90 check came back "not yet".
  last_checked_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (order_id, kind)
);

-- Deploy-day suppression backfill (0008's no-burst logic, but STRONGER: a
-- notice is a once-per-service event, and an un-warned about-to-expire
-- customer must not be ambushed by cron on release day). Every completed
-- purchase whose locally booked expiry is already INSIDE the 3-day window
-- (or past) is seeded 'sent' = skipped by policy. Services expiring later
-- get no row and flow through the normal live sweep. Re-runnable:
-- INSERT OR IGNORE on the same PK changes nothing.
INSERT OR IGNORE INTO service_notifications (order_id, kind, status)
SELECT o.id, 'expiring', 'sent'
  FROM orders o
 WHERE o.kind = 'purchase'
   AND o.state = 'completed'
   AND o.service_expires_at IS NOT NULL
   AND julianday(o.service_expires_at) <= julianday('now') + 3.0;
