-- Additive, versioned after 0023. No historical balance/order/ledger repair.
ALTER TABLE wallet_entries ADD COLUMN operation_key TEXT;
CREATE UNIQUE INDEX idx_wallet_operation_key ON wallet_entries(operation_key) WHERE operation_key IS NOT NULL;
ALTER TABLE referral_rewards ADD COLUMN ledger_id TEXT REFERENCES wallet_entries(id);
ALTER TABLE wallet_topups ADD COLUMN credit_status TEXT NOT NULL DEFAULT 'uncredited'
 CHECK(credit_status IN ('uncredited','credited','blocked','review_required'));
ALTER TABLE wallet_topups ADD COLUMN credit_error TEXT;
-- Legacy approval/ledger presence cannot prove an actual credit (old cap defect).
UPDATE wallet_topups SET credit_status='review_required' WHERE state='approved';
CREATE INDEX idx_wallet_refund_lookup ON wallet_entries(order_id) WHERE kind='order_refund';
CREATE INDEX idx_wallet_recovery_due ON wallet_entries(created_at,id)
 WHERE kind='order_payment' AND payment_token=order_id;
ALTER TABLE service_migrations ADD COLUMN blocked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_migrations ADD COLUMN next_recovery_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_migrations ADD COLUMN last_recovery_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_migration_recovery_due ON service_migrations(next_recovery_at,last_recovery_at,id)
 WHERE state IN ('creating','verified','activating') AND abort_requested=0;
