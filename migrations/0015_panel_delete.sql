-- Phase 16: panel-service deletion ("panel_deleted" terminal disposition).
--
-- Purely ADDITIVE against 0001-0014 (two nullable columns, no rebuilds, no
-- CHECK changes): orders.state keeps its frozen vocabulary EXCEPTED from this
-- feature on purpose — SQLite cannot extend a table CHECK without rebuilding
-- the hottest table under live FKs, and the deletion semantics do not need a
-- new lifecycle state. The terminal disposition is the pair of columns below:
--
--   panel_deleted_at  NON-NULL  ⇔  the row's panel service is GONE. This IS
--                 the `panel_deleted` state: no service-facing query may ever
--                 return the row again (list/detail/renew/sweep/failed-queue/
--                 provisioning claims all filter on it).
--   panel_deleted_by  'admin:<telegram_id>' for an admin command, or
--                 'system:<observer>' for a reconciliation (refresh tap,
--                 notification sweep, adoption pre-check) that found the
--                 service already deleted straight on the panel.
--
-- Order/payment/renewal/history rows are NEVER deleted by this feature, and
-- the audit trail records every transition as a 'service_panel_deleted'
-- order_event. Idempotent: a re-run on an already-stamped row is a no-op
-- (guarded UPDATE in db/orders.ts:markPanelDeleted).

ALTER TABLE orders ADD COLUMN panel_deleted_at TEXT;
ALTER TABLE orders ADD COLUMN panel_deleted_by TEXT;

-- Terminal exclusion from the "live services" surfaces is enforced in the
-- queries themselves; this partial index keeps the sweep/list filters cheap.
CREATE INDEX IF NOT EXISTS idx_orders_panel_alive
  ON orders (id)
  WHERE kind = 'purchase' AND state = 'completed' AND panel_deleted_at IS NULL;
