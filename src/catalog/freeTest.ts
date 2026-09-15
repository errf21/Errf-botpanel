/**
 * Free-test policy document (settings key 'free_test', seeded by 0014).
 * Same versioned-document contract as the provisioning/wallet loaders —
 * a malformed document never crashes an update and never invents defaults.
 *
 * FAIL DIRECTION — opposite of the sales switch (by design): missing row,
 * invalid JSON, wrong schema or a DB read error all mean the test is
 * NOT available. This feature hands out a real panel service for free to
 * everyone, so its default is closed; admins open it deliberately via D1.
 */

export const FREE_TEST_SCHEMA = 1;

/** 1 MB = 10^6 bytes on the panel wire (SI, matching GB_BYTES = 10^9). */
export const MB_BYTES = 1_000_000;

export interface FreeTestConfig {
  enabled: boolean;
  volumeMb: number;
  durationDays: number;
  deviceCount: number;
}

export type FreeTestResult =
  | { ok: true; config: FreeTestConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export function parseFreeTestConfig(doc: unknown): FreeTestResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== FREE_TEST_SCHEMA) {
    return { ok: false, error: 'free_test:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'free_test:enabled' };
  }
  const volumeMb = boundedInt(record['volume_mb'], 1, 100_000);
  if (volumeMb === null) return { ok: false, error: 'free_test:volume_mb' };
  const durationDays = boundedInt(record['duration_days'], 1, 366);
  if (durationDays === null) return { ok: false, error: 'free_test:duration_days' };
  const deviceCount = boundedInt(record['device_count'], 1, 10_000);
  if (deviceCount === null) return { ok: false, error: 'free_test:device_count' };
  return {
    ok: true,
    config: {
      enabled: record['enabled'],
      volumeMb,
      durationDays,
      deviceCount,
    },
  };
}

export async function loadFreeTestConfig(db: D1Database): Promise<FreeTestResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'free_test'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'free_test:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'free_test:missing' };
  try {
    return parseFreeTestConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'free_test:json' };
  }
}

/** The only gate callers use: available means loaded fine AND enabled. */
export async function freeTestAvailable(db: D1Database): Promise<FreeTestResult> {
  const loaded = await loadFreeTestConfig(db);
  if (loaded.ok && !loaded.config.enabled) {
    return { ok: false, error: 'free_test:disabled' };
  }
  return loaded;
}
