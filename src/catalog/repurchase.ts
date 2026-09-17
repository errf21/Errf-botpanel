/**
 * Repurchase policy: a versioned JSON document in the `settings` table
 * (seeded by 0019). Same degrade-safe contract as the renewal/catalog/
 * provisioning docs — a malformed document NEVER crashes an update and never
 * invents defaults; the caller treats it as "repurchases unavailable".
 *
 * Only two knobs today:
 *  - enabled: kill switch for the whole repurchase surface (buttons + applies).
 *  - nearExpiryDays: display tuning for the services list (same meaning as
 *    the renewal doc's knob); it never gates eligibility.
 */

export const REPURCHASE_SCHEMA = 1;

export interface RepurchaseConfig {
  enabled: boolean;
  nearExpiryDays: number;
}

export type RepurchaseResult =
  | { ok: true; config: RepurchaseConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseRepurchaseConfig(doc: unknown): RepurchaseResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== REPURCHASE_SCHEMA) {
    return { ok: false, error: 'repurchase:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'repurchase:enabled' };
  }
  const near = record['near_expiry_days'];
  if (
    typeof near !== 'number' ||
    !Number.isSafeInteger(near) ||
    near < 0 ||
    near > 90
  ) {
    return { ok: false, error: 'repurchase:near_expiry_days' };
  }
  return { ok: true, config: { enabled: record['enabled'], nearExpiryDays: near } };
}

export async function loadRepurchaseConfig(db: D1Database): Promise<RepurchaseResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'repurchase'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'repurchase:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'repurchase:missing' };
  try {
    return parseRepurchaseConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'repurchase:json' };
  }
}
