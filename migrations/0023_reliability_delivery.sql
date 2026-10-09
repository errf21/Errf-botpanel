-- Additive reliability state. Apply before this Worker version; no balance or order-state changes.
ALTER TABLE wallet_entries ADD COLUMN payment_token TEXT;
UPDATE wallet_entries SET payment_token=COALESCE(
 (SELECT idempotency_key FROM orders WHERE id=wallet_entries.order_id),order_id)
 WHERE kind='order_payment';
CREATE UNIQUE INDEX idx_wallet_payment_token ON wallet_entries(payment_token) WHERE kind='order_payment';
-- Compatibility: old Worker inserts also acquire a stable token, without changing balances.
CREATE TRIGGER wallet_payment_token_fill AFTER INSERT ON wallet_entries
 WHEN NEW.kind='order_payment' AND NEW.payment_token IS NULL
 BEGIN UPDATE wallet_entries SET payment_token=COALESCE(
   (SELECT idempotency_key FROM orders WHERE id=NEW.order_id),NEW.order_id) WHERE id=NEW.id; END;
-- Link new funded orders and their already-claimed ledger in the SAME insert transaction.
CREATE TRIGGER wallet_funded_order_guard BEFORE INSERT ON orders
 WHEN json_valid(NEW.selections) AND json_extract(NEW.selections,'$.wallet.credit_irt')>0
 AND NOT EXISTS(SELECT 1 FROM wallet_entries w WHERE w.kind='order_payment'
   AND w.payment_token=NEW.idempotency_key AND w.customer_id=NEW.customer_id
   AND w.delta_irt=-json_extract(NEW.selections,'$.wallet.credit_irt')
   AND NOT EXISTS(SELECT 1 FROM wallet_entries r WHERE r.kind='order_refund' AND r.order_id=w.order_id))
 BEGIN SELECT RAISE(ABORT,'wallet_payment_not_verified'); END;
CREATE TRIGGER wallet_funded_order_link AFTER INSERT ON orders
 WHEN json_valid(NEW.selections) AND json_extract(NEW.selections,'$.wallet.credit_irt')>0
 BEGIN UPDATE wallet_entries SET order_id=NEW.id WHERE kind='order_payment'
   AND payment_token=NEW.idempotency_key AND customer_id=NEW.customer_id; END;

ALTER TABLE announcements ADD COLUMN started_at TEXT;
ALTER TABLE announcements ADD COLUMN audience_highwater INTEGER;
ALTER TABLE announcements ADD COLUMN audience_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN audience_seeded INTEGER NOT NULL DEFAULT 0 CHECK(audience_seeded IN (0,1));
ALTER TABLE announcements ADD COLUMN recipient_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN active_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcement_deliveries ADD COLUMN claim_owner TEXT;
ALTER TABLE announcement_deliveries ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE announcement_deliveries ADD COLUMN lease_until INTEGER;
ALTER TABLE announcement_deliveries ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcement_deliveries ADD COLUMN failure_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcement_deliveries ADD COLUMN last_error TEXT;
ALTER TABLE announcement_deliveries ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE announcement_deliveries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE announcement_deliveries SET failure_attempts=attempts;
-- Only jobs with actual recipient history are known to have been started; drafts stay inert.
UPDATE announcements SET started_at=created_at WHERE EXISTS(
 SELECT 1 FROM announcement_deliveries d WHERE d.announcement_id=announcements.id);
UPDATE announcements SET recipient_count=(SELECT COUNT(*) FROM announcement_deliveries WHERE announcement_id=announcements.id),
 sent_count=(SELECT COUNT(*) FROM announcement_deliveries WHERE announcement_id=announcements.id AND status='sent'),
 failed_count=(SELECT COUNT(*) FROM announcement_deliveries WHERE announcement_id=announcements.id AND status='failed'),
 active_count=(SELECT COUNT(*) FROM announcement_deliveries WHERE announcement_id=announcements.id AND status='sending');
-- Pre-lease sending rows have unknown transport outcomes: reconciled as expired, never as sent.
UPDATE announcement_deliveries SET lease_until=0,last_error='legacy_delivery_outcome_unknown' WHERE status='sending';
CREATE TABLE announcement_dispatch (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 next_send_at INTEGER NOT NULL DEFAULT 0,pause_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO announcement_dispatch(singleton) VALUES(1);
CREATE INDEX idx_announcement_due ON announcement_deliveries(announcement_id,status,next_attempt_at,customer_id);
CREATE INDEX idx_announcement_started ON announcements(updated_at,id) WHERE state='sending' AND started_at IS NOT NULL;
CREATE TRIGGER announcement_recipient_added AFTER INSERT ON announcement_deliveries
 BEGIN UPDATE announcements SET recipient_count=recipient_count+1,sent_count=sent_count+(NEW.status='sent'),
 failed_count=failed_count+(NEW.status='failed'),active_count=active_count+(NEW.status='sending') WHERE id=NEW.announcement_id; END;
CREATE TRIGGER announcement_recipient_state AFTER UPDATE OF status ON announcement_deliveries WHEN NEW.status<>OLD.status
 BEGIN UPDATE announcements SET sent_count=sent_count+(NEW.status='sent')-(OLD.status='sent'),
 failed_count=failed_count+(NEW.status='failed')-(OLD.status='failed'),active_count=active_count+(NEW.status='sending')-(OLD.status='sending'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.announcement_id; END;
