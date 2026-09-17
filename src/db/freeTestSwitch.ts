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
 *    'disable' | 'enable' | 'volume' — replayable from the audit chain.
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

/** Canonical document JSON: the validated base with ONLY `volume_mb` changed. */
export function buildFreeTestVolumeDoc(base: FreeTestConfig, volumeMb: number): string {
  return JSON.stringify({
    schema: FREE_TEST_SCHEMA,
    enabled: base.enabled,
    volume_mb: volumeMb,
    duration_days: base.durationDays,
    device_count: base.deviceCount,
  });
}

/** Canonical free-test volume bounds (megabytes, integers only). Mirrors the
 *  loader contract (catalog/freeTest.ts boundedInt 1..100_000) so a value
 *  accepted here always parses back through parseFreeTestConfig. */
export const FREE_TEST_MIN_MB = 1;
export const FREE_TEST_MAX_MB = 100_000;

/** SI megabytes per gigabyte — explicit: 1 GB = 1000 MB = 1,000,000,000 B.
 *  Free-test NEVER uses the paid binary GiB (provision.ts GB_BYTES). */
export const FREE_TEST_MB_PER_GB = 1000;

export type FreeTestVolumeResult = { ok: true; volumeMb: number } | { ok: false; error: string };

const FA_DIGITS_RE = /[۰-۹]/g;
const AR_DIGITS_RE = /[٠-٩]/g;

/**
 * Strict admin volume input: `<int> MB|GB` (optional space, any case;
 * Persian/Arabic digits normalized). Integers only, SI units, range-checked
 * against the loader bounds. Never clamps — anything else is an error and
 * the caller must leave the configuration untouched.
 */
export function parseTestVolume(raw: unknown): FreeTestVolumeResult {
  if (typeof raw !== 'string') return { ok: false, error: 'volume:invalid' };
  const normalized = raw
    .replace(FA_DIGITS_RE, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(AR_DIGITS_RE, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const match = /^\s*([0-9]{1,6})\s*(mb|gb)\s*$/i.exec(normalized);
  if (!match) return { ok: false, error: 'volume:format' };
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: 'volume:range' };
  const unit = (match[2] ?? '').toLowerCase();
  const volumeMb = unit === 'gb' ? amount * FREE_TEST_MB_PER_GB : amount;
  if (!Number.isSafeInteger(volumeMb) || volumeMb < FREE_TEST_MIN_MB || volumeMb > FREE_TEST_MAX_MB) {
    return { ok: false, error: 'volume:range' };
  }
  return { ok: true, volumeMb };
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
    action: 'disable' | 'enable' | 'volume';
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
