/**
 * Referral policy: a versioned JSON document in the `settings` table (seeded
 * by 0007). Same degrade-safe contract as the other settings documents —
 * missing/malformed means "referrals pay nothing right now" and payout is a
 * strict no-op (attribution capture keeps working, it needs no config).
 *
 * Knobs:
 *  - enabled: payout kill switch.
 *  - rewardPercent: integer PERCENT (1-100) of the referee's first approved
 *    purchase total (order amount + wallet credit) paid ONCE to the referrer,
 *    floored to whole IRT.
 *  - maxRewardsPerReferrer: lifetime cap per referrer (multi-account farming
 *    brake; enforced in the payout guard query, not in the UI).
 */

export const REFERRAL_SCHEMA = 1;
const MIN_PERCENT = 1;
const MAX_PERCENT = 100;
const MAX_CAP = 100_000;

export interface ReferralConfig {
  enabled: boolean;
  rewardPercent: number;
  maxRewardsPerReferrer: number;
}

export type ReferralResult =
  | { ok: true; config: ReferralConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export function parseReferralConfig(doc: unknown): ReferralResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== REFERRAL_SCHEMA) {
    return { ok: false, error: 'referral:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'referral:enabled' };
  }
  const percent = asInt(record['reward_percent'], MIN_PERCENT, MAX_PERCENT);
  const cap = asInt(record['max_rewards_per_referrer'], 1, MAX_CAP);
  if (percent === null || cap === null) {
    return { ok: false, error: 'referral:percent_or_cap' };
  }
  return {
    ok: true,
    config: { enabled: record['enabled'], rewardPercent: percent, maxRewardsPerReferrer: cap },
  };
}

export async function loadReferralConfig(db: D1Database): Promise<ReferralResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'referral'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'referral:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'referral:missing' };
  try {
    return parseReferralConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'referral:json' };
  }
}
