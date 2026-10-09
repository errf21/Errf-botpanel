-- Versioned migration: Wrangler applies once via d1_migrations. No table rebuild,
-- DROP, or cascading deletes. Rename the old UNIQUE column to preserve its data
-- and constraint, then add the authoritative, panel-scoped external identifier.
CREATE TABLE panels (
  id TEXT PRIMARY KEY CHECK (id IN ('legacy','secondary')),
  name TEXT NOT NULL,
  origin TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('api_key','password')),
  credentials TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled_new INTEGER NOT NULL DEFAULT 1 CHECK (enabled_new IN (0,1)),
  group_ids TEXT CHECK (group_ids IS NULL OR json_valid(group_ids)),
  login_safe INTEGER NOT NULL DEFAULT 0 CHECK (login_safe IN (0,1)),
  token_ciphertext TEXT,
  token_expires_at INTEGER,
  token_lease TEXT,
  token_lease_until INTEGER,
  login_backoff_until INTEGER,
  last_change TEXT,
  last_test TEXT,
  last_test_at TEXT
);
INSERT INTO panels(id,name,auth_type) VALUES ('legacy','Existing panel','api_key');
CREATE TABLE panel_selection (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  panel_id TEXT NOT NULL REFERENCES panels(id),
  revision INTEGER NOT NULL DEFAULT 1,
  last_change TEXT
);
INSERT INTO panel_selection(singleton,panel_id,revision) VALUES (1,'legacy',1);
ALTER TABLE orders RENAME COLUMN pasarguard_user_id TO legacy_pasarguard_user_id;
ALTER TABLE orders ADD COLUMN pasarguard_user_id TEXT;
ALTER TABLE orders ADD COLUMN panel_id TEXT REFERENCES panels(id);
ALTER TABLE orders ADD COLUMN panel_provision_config TEXT;
ALTER TABLE orders ADD COLUMN create_target_unix INTEGER;
ALTER TABLE orders ADD COLUMN provision_claim TEXT;
UPDATE orders SET pasarguard_user_id=legacy_pasarguard_user_id, panel_id='legacy';
CREATE UNIQUE INDEX idx_orders_panel_user ON orders(panel_id,pasarguard_user_id)
  WHERE pasarguard_user_id IS NOT NULL;
CREATE INDEX idx_orders_panel ON orders(panel_id);
CREATE TRIGGER orders_panel_immutable BEFORE UPDATE OF panel_id ON orders
WHEN OLD.panel_id IS NOT NULL AND NEW.panel_id IS NOT OLD.panel_id
BEGIN SELECT RAISE(ABORT,'panel_assignment_immutable'); END;
CREATE TRIGGER orders_external_requires_panel BEFORE UPDATE OF pasarguard_user_id ON orders
WHEN NEW.pasarguard_user_id IS NOT NULL AND NEW.panel_id IS NULL
BEGIN SELECT RAISE(ABORT,'external_identity_requires_panel'); END;
CREATE TABLE panel_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  panel_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE panel_admin_sessions (
  nonce TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  panel_revision INTEGER NOT NULL,
  selection_revision INTEGER NOT NULL,
  enabled_new INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE panel_service_locks (
  service_id TEXT PRIMARY KEY REFERENCES orders(id),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
