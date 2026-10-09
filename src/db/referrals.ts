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

/** Eligibility, once-per-referee anchor, ledger claim and credit are one atomic
 * transaction. A failed SQL operation rolls all effects back. Historical
 * anchors remain once-only even when their legacy ledger evidence is missing. */
export async function maybePayReferralReward(db:D1Database,opts:{refereeCustomerId:number;orderId:string;rewardIrt:number;config:ReferralConfig}):Promise<ReferralPayoutOutcome|null>{
 if(!opts.config.enabled||!Number.isSafeInteger(opts.rewardIrt)||opts.rewardIrt<=0)return null;
 const ledger=newOrderId();
 try{await db.batch([
  db.prepare(`INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after,operation_key)
   SELECT ?1,ref.id,?2,'referral_reward',?3,'system',ref.balance_irt+?2,?6 FROM customers c JOIN customers ref ON ref.id=c.referred_by
   WHERE c.id=?4 AND c.referred_by<>c.id AND ref.balance_irt+?2 BETWEEN 0 AND 1000000000000
   AND (SELECT COUNT(*) FROM referral_rewards WHERE referrer_customer_id=ref.id)<?5
   AND NOT EXISTS(SELECT 1 FROM referral_rewards WHERE referred_customer_id=c.id)`)
   .bind(ledger,opts.rewardIrt,opts.orderId,opts.refereeCustomerId,opts.config.maxRewardsPerReferrer,`referral:${opts.refereeCustomerId}`),
  db.prepare(`INSERT INTO referral_rewards(referred_customer_id,referrer_customer_id,order_id,amount_irt,ledger_id)
   SELECT ?1,customer_id,?2,delta_irt,id FROM wallet_entries WHERE id=?3`)
   .bind(opts.refereeCustomerId,opts.orderId,ledger),
  db.prepare(`UPDATE customers SET balance_irt=balance_irt+?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id=(SELECT customer_id FROM wallet_entries WHERE id=?2)`).bind(opts.rewardIrt,ledger),
 ]);}catch{ /* An uncertain committed response is reconciled against THIS claim. */ }
 const result=await db.prepare('SELECT referrer_customer_id,amount_irt FROM referral_rewards WHERE referred_customer_id=?1 AND ledger_id=?2')
  .bind(opts.refereeCustomerId,ledger).first<{referrer_customer_id:number;amount_irt:number}>();
 return result?{referrerCustomerId:result.referrer_customer_id,amountIrt:result.amount_irt}:null;
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
