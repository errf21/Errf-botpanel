/**
 * Renewal policy: a versioned JSON document in the `settings` table (seeded
 * by 0006). Same degrade-safe contract as the catalog/payment/provisioning
 * docs — a malformed document NEVER crashes an update and never invents
 * defaults; the caller treats it as "renewals are not available right now".
 *
 * Only two knobs today:
 *  - enabled: kill switch for the whole renewal surface (buttons + applies).
 *  - nearExpiryDays: how close to expiry the "expiring soon" warning lights
 *    up. Cosmetic; it never blocks a renewal (services are always renewable).
 */

export const RENEWAL_SCHEMA = 1;

export interface RenewalConfig {
  enabled: boolean;
  nearExpiryDays: number;
}

export type RenewalResult =
  | { ok: true; config: RenewalConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseRenewalConfig(doc: unknown): RenewalResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== RENEWAL_SCHEMA) {
    return { ok: false, error: 'renewal:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'renewal:enabled' };
  }
  const near = record['near_expiry_days'];
  if (
    typeof near !== 'number' ||
    !Number.isSafeInteger(near) ||
    near < 0 ||
    near > 90
  ) {
    return { ok: false, error: 'renewal:near_expiry_days' };
  }
  return { ok: true, config: { enabled: record['enabled'], nearExpiryDays: near } };
}

export async function loadRenewalConfig(db: D1Database): Promise<RenewalResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'renewal'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'renewal:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'renewal:missing' };
  try {
    return parseRenewalConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'renewal:json' };
  }
}
