-- Keep 0020 immutable for installations that already applied it. D1 enables
-- foreign keys; defer NO ACTION references while replacing ONLY the registry.
-- No child table is rebuilt. No child relationship uses ON DELETE CASCADE.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE panels_api_key (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 32 AND id NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL,
  origin TEXT,
  auth_type TEXT NOT NULL DEFAULT 'api_key' CHECK(auth_type='api_key'),
  credentials TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled_new INTEGER NOT NULL DEFAULT 0 CHECK(enabled_new IN (0,1)),
  group_ids TEXT CHECK(group_ids IS NULL OR json_valid(group_ids)),
  last_change TEXT,
  last_test TEXT,
  last_test_at TEXT
);
INSERT INTO panels_api_key
  SELECT id,name,origin,'api_key',
    CASE WHEN auth_type='api_key' THEN credentials ELSE NULL END,
    revision + CASE WHEN auth_type='password' THEN 1 ELSE 0 END,
    CASE WHEN auth_type='api_key' THEN enabled_new ELSE 0 END,
    group_ids,last_change,
    CASE WHEN auth_type='api_key' THEN last_test ELSE 'api_key_required' END,
    CASE WHEN auth_type='api_key' THEN last_test_at ELSE NULL END
  FROM panels;
-- Existing password credentials/tokens are intentionally discarded, NOT
-- interpreted as API keys. Keep the panel ID and all associated orders intact.
UPDATE panel_selection SET panel_id='legacy',revision=revision+1,last_change=NULL
  WHERE panel_id IN (SELECT id FROM panels WHERE auth_type='password');
DROP TABLE panels;
ALTER TABLE panels_api_key RENAME TO panels;
CREATE UNIQUE INDEX idx_panels_origin ON panels(origin) WHERE origin IS NOT NULL;
CREATE TRIGGER panel_origin_preserves_identity BEFORE UPDATE OF origin ON panels
WHEN NEW.origin IS NOT OLD.origin AND EXISTS(SELECT 1 FROM orders WHERE panel_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'panel_origin_has_associations'); END;
CREATE TRIGGER panel_delete_preserves_identity BEFORE DELETE ON panels
WHEN OLD.id='legacy' OR EXISTS(SELECT 1 FROM orders WHERE panel_id=OLD.id)
 OR EXISTS(SELECT 1 FROM panel_selection WHERE panel_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'panel_has_associations_or_selected'); END;
-- SQLite's deferred DROP counter can remain set even after the parent name is
-- restored. Validate EVERY FK explicitly before releasing that deferral; fail
-- and roll back this whole migration if any reference is inconsistent.
CREATE TABLE panel_migration_fk_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO panel_migration_fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE panel_migration_fk_guard;
PRAGMA defer_foreign_keys = OFF;
