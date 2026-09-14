/**
 * Referrals (Phase 7): first-touch attribution + exactly-once payout.
 *
 * Guards (all DB-level, mirroring the project's transition discipline):
 *  - attribution fires ONLY while `referred_by IS NULL` (first /start with a
 *    code ever) and never to self (customer id <> referrer id).
 *  - payout fires ONLY when a purchase order first reaches 'approved': the
 *    referral_rewards PK (one row per referee) makes double pays impossible;
 *    the per-referrer cap is one COUNT check inside the same guarded write.
 */
import { newOrderId } from '../lib/security.ts';
import type { ReferralConfig } from '../catalog/referral.ts';

/** Referral codes: 12 Crockford base32 chars (ULID alphabet), CSPRNG-minted. */
const CODE_LENGTH = 12;
const CODE_PATTERN = new RegExp(`^[0-9A-HJKMNP-TV-Z]{${CODE_LENGTH}}$`);

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function isReferralCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

/**
 * A fresh referral code, drawn straight from the CSPRNG.
 *
 * Deliberately NOT a slice of `newOrderId()`: that id leads with the
 * `Date.now()` timestamp, so a sliced code is predictable — everyone minting
 * in the same window shares its leading characters, which makes invites and
 * attributions enumerable. The 32-symbol alphabet consumes exactly five low
 * bits per random byte, so no symbol is biased. 60 bits of entropy land well
 * inside the UNIQUE-index collision budget retried by `ensureReferralCode`.
 */
export function newReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (byte) => ALPHABET[byte & 31] ?? '0').join('');
}

/** Mint a fresh code and attach it when absent (idempotent lazy backfill). */
export async function ensureReferralCode(db: D1Database, customerId: number): Promise<string | null> {
  const current = await db
    .prepare('SELECT referral_code FROM customers WHERE id = ?1')
    .bind(customerId)
    .first<{ referral_code: string | null }>();
  if (current?.referral_code) return current.referral_code;
  for (let tries = 0; tries < 3; tries++) {
    const code = newReferralCode();
    try {
      const updated = await db
        .prepare('UPDATE customers SET referral_code = ?2 WHERE id = ?1 AND referral_code IS NULL')
        .bind(customerId, code)
        .run();
      const won = ((updated as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) === 1;
      if (won) return code;
    } catch {
      // UNIQUE collision on a random mint: retry with a fresh code.
    }
    const raced = await db
      .prepare('SELECT referral_code FROM customers WHERE id = ?1')
      .bind(customerId)
      .first<{ referral_code: string | null }>();
    if (raced?.referral_code) return raced.referral_code;
  }
  return null;
}

/**
 * First-touch attribution: sets referred_by exactly once. Returns the
 * referrer's customer id on success, null on any miss (bad code, self,
 * race-lost, already attributed, unknown referrer).
 */
export async function attributeReferral(
  db: D1Database,
  opts: { refereeCustomerId: number; code: string },
): Promise<{ referrerCustomerId: number } | null> {
  if (!isReferralCode(opts.code)) return null;
  const referrer = await db
    .prepare('SELECT id FROM customers WHERE referral_code = ?1')
    .bind(opts.code)
    .first<{ id: number }>();
  if (!referrer || referrer.id === opts.refereeCustomerId) return null;
  const updated = await db
    .prepare(
      `UPDATE customers
          SET referred_by = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND referred_by IS NULL`,
    )
    .bind(opts.refereeCustomerId, referrer.id)
    .run();
  const won = ((updated as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) === 1;
  if (!won) return null;
  return { referrerCustomerId: referrer.id };
}

export interface ReferralPayoutOutcome {
  referrerCustomerId: number;
  amountIrt: number;
}

/**
 * Pay the referrer for THIS referee's first approved purchase — or report
 * why nothing happened. `rewardIrt` is the percentage-computed reward
 * (already floored to whole IRT by the payout caller). Single guarded-INSERT
 * decision:
 *   INSERT ... SELECT ... WHERE <referee attributed & not yet paid>
 *                        AND <referrer cap not reached>
 * The PK collision is the concurrency guard; a false return NEVER means an
 * error — always "no payout for this order" (unattributed, already paid,
 * capped, or kill switch). The wallet credit runs only when this call
 * inserted the row, and the row itself is the ledger reconciliation anchor.
 */
export async function maybePayReferralReward(
  db: D1Database,
  opts: {
    refereeCustomerId: number;
    orderId: string;
    rewardIrt: number;
    config: ReferralConfig;
  },
): Promise<ReferralPayoutOutcome | null> {
  if (
    !opts.config.enabled ||
    !Number.isSafeInteger(opts.rewardIrt) ||
    opts.rewardIrt <= 0
  ) {
    return null;
  }
  const referee = await db
    .prepare('SELECT referred_by FROM customers WHERE id = ?1')
    .bind(opts.refereeCustomerId)
    .first<{ referred_by: number | null }>();
  const referrerId = referee?.referred_by ?? null;
  if (referrerId === null) return null;

  const inserted = await db
    .prepare(
      `INSERT INTO referral_rewards (referred_customer_id, referrer_customer_id, order_id, amount_irt)
       SELECT ?1, c.referred_by, ?2, ?3
         FROM customers c
        WHERE c.id = ?1 AND c.referred_by IS NOT NULL
          AND c.referred_by != c.id
          AND (
            SELECT COUNT(*) FROM referral_rewards r
             WHERE r.referrer_customer_id = c.referred_by
          ) < ?4
          AND NOT EXISTS (
            SELECT 1 FROM referral_rewards p WHERE p.referred_customer_id = ?1
          )`,
    )
    .bind(
      opts.refereeCustomerId,
      opts.orderId,
      opts.rewardIrt,
      opts.config.maxRewardsPerReferrer,
    )
    .run();
  const won = ((inserted as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) === 1;
  if (!won) return null;

  // Credit the referrer exactly once (their balance is the effect; if this
  // write fails the reward row stands — a later admin audit can reconcile;
  // in practice both are D1 statements on the same isolate).
  const credited = await db
    .prepare(
      `UPDATE customers
          SET balance_irt = balance_irt + ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND balance_irt + ?2 <= 1000000000000`,
    )
    .bind(referrerId, opts.rewardIrt)
    .run();
  if (((credited as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) !== 1) {
    console.error(`referral_credit_failed referrer=${String(referrerId)}`);
    return null;
  }
  const balance = await db
    .prepare('SELECT balance_irt FROM customers WHERE id = ?1')
    .bind(referrerId)
    .first<{ balance_irt: number }>();
  await db
    .prepare(
      `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
       VALUES (?1, ?2, ?3, 'referral_reward', ?4, 'system', ?5)`,
    )
    .bind(
      newOrderId(),
      referrerId,
      opts.rewardIrt,
      opts.orderId,
      balance?.balance_irt ?? opts.rewardIrt,
    )
    .run();
  return { referrerCustomerId: referrerId, amountIrt: opts.rewardIrt };
}

/** Light stats for the invite screen. */
export async function referralStats(
  db: D1Database,
  customerId: number,
): Promise<{ referees: number; earnedIrt: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS referees, COALESCE(SUM(amount_irt), 0) AS earned
         FROM referral_rewards WHERE referrer_customer_id = ?1`,
    )
    .bind(customerId)
    .first<{ referees: number; earned: number }>();
  return { referees: row?.referees ?? 0, earnedIrt: row?.earned ?? 0 };
}
