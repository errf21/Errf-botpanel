/**
 * Phase 23: database side of the free-test stop switch (/stoptest).
 *
 *  - The live document lives in `settings['free_test']` (schema 1, 0014):
 *    {schema, enabled, volume_mb, duration_days, device_count}.
 *  - Toggling flips ONLY `enabled`, byte-preserving every other field —
 *    an admin toggle must never silently resize the test offer.
 *  - Guarded compare-and-swap UPDATE (two admins, one winner) followed by an
 *    append-only `settings_audit` row (key 'free_test'), exactly the model
 *    proven by the sales switch (src/db/sales.ts).
 *  - Actor is `admin:<telegram_user_id>` (verified sender only), action is
 *    'disable' | 'enable' — replayable from the audit chain.
 *  - FAIL-CLOSED like the loader: a missing/malformed row is never seeded or
 *    repaired here (seeding would invent policy); callers report and stop.
 */
import { FREE_TEST_SCHEMA, parseFreeTestConfig, type FreeTestConfig } from '../catalog/freeTest.ts';

const FREE_TEST_KEY = 'free_test';

export interface FreeTestSettingsRow {
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export async function getFreeTestSettingsRow(
  db: D1Database,
): Promise<FreeTestSettingsRow | null> {
  return db
    .prepare(`SELECT value, updated_by, updated_at FROM settings WHERE key = ?1`)
    .bind(FREE_TEST_KEY)
    .first<FreeTestSettingsRow>();
}

/** Canonical document JSON: the validated base with ONLY `enabled` flipped. */
export function buildFreeTestDoc(base: FreeTestConfig, enabled: boolean): string {
  return JSON.stringify({
    schema: FREE_TEST_SCHEMA,
    enabled,
    volume_mb: base.volumeMb,
    duration_days: base.durationDays,
    device_count: base.deviceCount,
  });
}

/** Parse the stored row into a validated config, or null when unusable. */
export function parseStoredFreeTestDoc(raw: string): FreeTestConfig | null {
  try {
    const loaded = parseFreeTestConfig(JSON.parse(raw));
    return loaded.ok ? loaded.config : null;
  } catch {
    return null;
  }
}

export type FreeTestApplyResult = 'applied' | 'conflict' | 'missing';

/**
 * CAS the switch. Returns 'applied' only when the row still held exactly
 * `oldJson`; 'conflict' leaves the winner's document untouched; 'missing'
 * means the row vanished mid-flight (the caller re-reads the true state).
 */
export async function applyFreeTestToggleCas(
  db: D1Database,
  args: {
    oldJson: string;
    newJson: string;
    adminUserId: number;
    action: 'disable' | 'enable';
  },
): Promise<FreeTestApplyResult> {
  const actor = `admin:${String(args.adminUserId)}`;
  const now = new Date().toISOString();
  const swapped = await db
    .prepare(
      `UPDATE settings
          SET value = ?2, updated_by = ?3, updated_at = ?4
        WHERE key = ?1 AND value = ?5`,
    )
    .bind(FREE_TEST_KEY, args.newJson, actor, now, args.oldJson)
    .run();
  const changes = swapped?.meta?.changes ?? 0;
  if (changes === 0) {
    const still = await getFreeTestSettingsRow(db);
    if (still === null) return 'missing';
    return 'conflict';
  }
  await db
    .prepare(
      `INSERT INTO settings_audit (key, actor, action, old_value, new_value)
       VALUES ('free_test', ?1, ?2, ?3, ?4)`,
    )
    .bind(actor, args.action, args.oldJson, args.newJson)
    .run();
  return 'applied';
}
