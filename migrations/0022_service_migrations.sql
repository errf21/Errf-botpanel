-- Additive: no customer/order/payment/wallet/history updates or table rebuilds.
-- Versioned once by Wrangler d1_migrations; apply before deploying the new code.
CREATE TABLE service_migrations (
 id TEXT PRIMARY KEY,
 service_id TEXT NOT NULL REFERENCES orders(id),
 customer_id INTEGER NOT NULL REFERENCES customers(id),
 operator TEXT NOT NULL,
 source_migration_id TEXT REFERENCES service_migrations(id),
 source_panel_id TEXT NOT NULL REFERENCES panels(id),
 source_origin TEXT NOT NULL,
 source_user_id TEXT NOT NULL,
 source_username TEXT NOT NULL,
 source_url TEXT,
 destination_panel_id TEXT NOT NULL REFERENCES panels(id),
 destination_origin TEXT NOT NULL,
 destination_revision INTEGER NOT NULL,
 destination_username TEXT NOT NULL UNIQUE,
 destination_user_id TEXT,
 destination_url TEXT,
 destination_config TEXT NOT NULL CHECK(json_valid(destination_config)),
 state TEXT NOT NULL CHECK(state IN ('review','creating','verified','activating','cleanup_pending','completed','cancelled')),
 entitlement TEXT CHECK(entitlement IS NULL OR json_valid(entitlement)),
 confirmed_by TEXT,
 confirmed_at TEXT,
 confirmation_token TEXT NOT NULL UNIQUE,
 review_expires_at INTEGER NOT NULL,
 abort_requested INTEGER NOT NULL DEFAULT 0 CHECK(abort_requested IN (0,1)),
 create_attempts INTEGER NOT NULL DEFAULT 0,
 revoke_attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 source_revoked_at TEXT,
 customer_notified_at TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(source_panel_id<>destination_panel_id),
 UNIQUE(destination_panel_id,destination_user_id)
);
CREATE UNIQUE INDEX idx_one_open_service_migration ON service_migrations(service_id)
 WHERE state IN ('review','creating','verified','activating');
CREATE TABLE service_migration_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 migration_id TEXT NOT NULL REFERENCES service_migrations(id),
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_migration_transition_once ON service_migration_events(migration_id,action)
 WHERE action IN ('confirmed','verified','active_switched','source_absence_confirmed');
CREATE TABLE active_service_resources (
 service_id TEXT PRIMARY KEY REFERENCES orders(id),
 migration_id TEXT NOT NULL UNIQUE REFERENCES service_migrations(id),
 panel_id TEXT NOT NULL REFERENCES panels(id),
 user_id TEXT NOT NULL,
 username TEXT NOT NULL UNIQUE,
 subscription_url TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 provision_config TEXT NOT NULL CHECK(json_valid(provision_config)),
 UNIQUE(panel_id,user_id)
);
CREATE TABLE service_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 service_id TEXT NOT NULL REFERENCES orders(id),
 panel_id TEXT NOT NULL REFERENCES panels(id),
 origin TEXT,
 user_id TEXT NOT NULL,
 username TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 observed_at INTEGER NOT NULL
);
CREATE INDEX idx_service_observation ON service_observations(service_id,panel_id,user_id,observed_at DESC);
CREATE TRIGGER migration_entitlement_immutable BEFORE UPDATE ON service_migrations
 WHEN OLD.state<>'review' AND (NEW.entitlement IS NOT OLD.entitlement OR NEW.source_panel_id<>OLD.source_panel_id
 OR NEW.source_migration_id IS NOT OLD.source_migration_id OR NEW.source_username<>OLD.source_username OR NEW.operator<>OLD.operator
 OR NEW.destination_config<>OLD.destination_config OR NEW.source_origin<>OLD.source_origin OR NEW.destination_origin<>OLD.destination_origin OR NEW.source_user_id<>OLD.source_user_id OR NEW.destination_panel_id<>OLD.destination_panel_id
 OR NEW.destination_username<>OLD.destination_username OR NEW.customer_id<>OLD.customer_id OR NEW.service_id<>OLD.service_id)
 BEGIN SELECT RAISE(ABORT,'migration_identity_or_entitlement_immutable'); END;
CREATE TRIGGER migration_customer_guard BEFORE INSERT ON service_migrations
 WHEN NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.service_id AND customer_id=NEW.customer_id AND kind='purchase' AND state='completed' AND panel_deleted_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'migration_service_owner_invalid'); END;
CREATE TRIGGER migration_panel_origin_guard BEFORE UPDATE OF origin ON panels
 WHEN NEW.origin IS NOT OLD.origin AND (EXISTS(SELECT 1 FROM service_migrations WHERE source_panel_id=OLD.id OR destination_panel_id=OLD.id)
 OR EXISTS(SELECT 1 FROM active_service_resources WHERE panel_id=OLD.id))
 BEGIN SELECT RAISE(ABORT,'migration_panel_has_history'); END;
CREATE TRIGGER migration_panel_delete_guard BEFORE DELETE ON panels
 WHEN EXISTS(SELECT 1 FROM service_migrations WHERE source_panel_id=OLD.id OR destination_panel_id=OLD.id)
 OR EXISTS(SELECT 1 FROM active_service_resources WHERE panel_id=OLD.id)
 OR EXISTS(SELECT 1 FROM service_observations WHERE panel_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'migration_panel_has_history'); END;
CREATE TRIGGER active_resource_insert_guard BEFORE INSERT ON active_service_resources
 WHEN NOT EXISTS(SELECT 1 FROM service_migrations m JOIN orders o ON o.id=m.service_id
 WHERE m.id=NEW.migration_id AND m.state='activating' AND m.service_id=NEW.service_id AND o.customer_id=m.customer_id
 AND m.destination_panel_id=NEW.panel_id AND m.destination_user_id=NEW.user_id AND m.destination_username=NEW.username AND m.destination_url=NEW.subscription_url)
 BEGIN SELECT RAISE(ABORT,'unverified_active_resource'); END;
CREATE TRIGGER active_resource_update_guard BEFORE UPDATE OF migration_id,panel_id,user_id,username ON active_service_resources
 WHEN NOT EXISTS(SELECT 1 FROM service_migrations m JOIN orders o ON o.id=m.service_id
 WHERE m.id=NEW.migration_id AND m.state='activating' AND m.service_id=NEW.service_id AND o.customer_id=m.customer_id
 AND m.destination_panel_id=NEW.panel_id AND m.destination_user_id=NEW.user_id AND m.destination_username=NEW.username AND m.destination_url=NEW.subscription_url)
 BEGIN SELECT RAISE(ABORT,'unverified_active_resource'); END;
CREATE VIEW effective_orders AS SELECT
  r.migration_id AS active_migration_id,
  o."id",
  o."customer_id",
  o."state",
  o."selections",
  o."amount",
  o."currency",
  o."receipt_file_id",
  o."payment_reference",
  o."verified_by",
  o."verified_at",
  CASE WHEN r.service_id IS NOT NULL THEN r.username ELSE o."pasarguard_username" END AS "pasarguard_username",
  o."legacy_pasarguard_user_id",
  o."service_created_at",
  o."failure_reason",
  o."created_at",
  o."updated_at",
  o."idempotency_key",
  o."provision_attempts",
  CASE WHEN r.service_id IS NOT NULL THEN r.subscription_url ELSE o."subscription_url" END AS "subscription_url",
  o."kind",
  o."renews_order_id",
  CASE WHEN r.service_id IS NOT NULL THEN r.expires_at ELSE o."service_expires_at" END AS "service_expires_at",
  o."renew_target_unix",
  o."panel_deleted_at",
  o."panel_deleted_by",
  o."renew_target_data_limit_bytes",
  o."repurchase_mode",
  o."repurchase_target_quota_bytes",
  o."repurchase_target_unix",
  o."repurchase_target_hwid",
  o."repurchase_reset_done",
  CASE WHEN r.service_id IS NOT NULL THEN r.user_id ELSE o."pasarguard_user_id" END AS "pasarguard_user_id",
  CASE WHEN r.service_id IS NOT NULL THEN r.panel_id ELSE o."panel_id" END AS "panel_id",
  CASE WHEN r.service_id IS NOT NULL THEN r.provision_config ELSE o."panel_provision_config" END AS "panel_provision_config",
  o."create_target_unix",
  o."provision_claim"
 FROM orders o LEFT JOIN active_service_resources r ON r.service_id=o.id;

CREATE TABLE migration_admin_choices (
 nonce TEXT PRIMARY KEY,
 actor TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('destination','revoke','abort')),
 service_id TEXT NOT NULL REFERENCES orders(id),
 customer_id INTEGER NOT NULL REFERENCES customers(id),
 panel_id TEXT REFERENCES panels(id) ON DELETE CASCADE,
 migration_id TEXT REFERENCES service_migrations(id),
 expires_at INTEGER NOT NULL
);
-- Cross-table identity exclusivity. Remote IDs remain scoped to their panel,
-- but an active migration resource must never become another customer's order.
CREATE TRIGGER order_migrated_identity_insert_guard BEFORE INSERT ON orders
 WHEN NEW.pasarguard_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_service_resources
  WHERE panel_id=NEW.panel_id AND user_id=NEW.pasarguard_user_id AND service_id<>NEW.id)
 BEGIN SELECT RAISE(ABORT,'active_external_identity_conflict'); END;
CREATE TRIGGER order_migrated_identity_update_guard BEFORE UPDATE OF panel_id,pasarguard_user_id ON orders
 WHEN NEW.pasarguard_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_service_resources
  WHERE panel_id=NEW.panel_id AND user_id=NEW.pasarguard_user_id AND service_id<>NEW.id)
 BEGIN SELECT RAISE(ABORT,'active_external_identity_conflict'); END;
CREATE TRIGGER active_order_identity_insert_guard BEFORE INSERT ON active_service_resources
 WHEN EXISTS(SELECT 1 FROM orders WHERE panel_id=NEW.panel_id AND pasarguard_user_id=NEW.user_id AND id<>NEW.service_id)
 BEGIN SELECT RAISE(ABORT,'historical_external_identity_conflict'); END;
CREATE TRIGGER active_order_identity_update_guard BEFORE UPDATE OF panel_id,user_id ON active_service_resources
 WHEN EXISTS(SELECT 1 FROM orders WHERE panel_id=NEW.panel_id AND pasarguard_user_id=NEW.user_id AND id<>NEW.service_id)
 BEGIN SELECT RAISE(ABORT,'historical_external_identity_conflict'); END;

CREATE TRIGGER migration_blocks_lifecycle_checkout BEFORE INSERT ON orders
 WHEN NEW.renews_order_id IS NOT NULL AND EXISTS(SELECT 1 FROM service_migrations
  WHERE service_id=NEW.renews_order_id AND state IN ('review','creating','verified','activating'))
 BEGIN SELECT RAISE(ABORT,'service_migration_busy'); END;

CREATE TRIGGER migration_abort_irreversible BEFORE UPDATE OF abort_requested ON service_migrations
 WHEN OLD.abort_requested=1 AND NEW.abort_requested<>1
 BEGIN SELECT RAISE(ABORT,'migration_abort_irreversible'); END;
