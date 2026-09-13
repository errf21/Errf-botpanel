/**
 * Shared post-approval side effects for BOTH approval paths (manual admin
 * review and wallet auto-pay): the referral payout. Kept out of admin.ts to
 * avoid import cycles; provisioning keeps its own module.
 */
import type { TelegramApiLike } from '../types.ts';
import { loadReferralConfig } from '../catalog/referral.ts';
import { maybePayReferralReward } from '../db/referrals.ts';
import { notifyReferralPaid } from '../handlers/referrals.ts';
import { walletCreditFromSnapshot } from '../orders/checkout.ts';
import type { OrderRow } from '../db/orders.ts';

/**
 * Pay the referrer when THIS purchase order is the referee's first approved
 * real purchase (guarded by the referral_rewards PK): an integer percent of
 * the purchase TOTAL — order amount plus any wallet credit applied to it,
 * all server-side numbers (snapshot), floored to whole IRT. Any
 * unavailable/missing config ⇒ silent no-op, matching the project's
 * fail-closed philosophy for optional subsystems.
 */
export async function payReferrerIfDue(
  db: D1Database,
  api: TelegramApiLike,
  order: OrderRow,
  actorTag: string,
): Promise<void> {
  void actorTag;
  if (order.kind !== 'purchase') return;
  const loaded = await loadReferralConfig(db);
  if (!loaded.ok || !loaded.config.enabled) return;
  const base = order.amount + (walletCreditFromSnapshot(order) ?? 0);
  const rewardIrt = referralRewardIrt(base, loaded.config.rewardPercent);
  if (rewardIrt < 1) return; // floors to zero (or invalid base): nothing pays, referee slot stays free
  const paid = await maybePayReferralReward(db, {
    refereeCustomerId: order.customer_id,
    orderId: order.id,
    rewardIrt,
    config: loaded.config,
  });
  if (!paid) return;
  await notifyReferralPaid(api, db, {
    referrerCustomerId: paid.referrerCustomerId,
    refereeCustomerId: order.customer_id,
    amountIrt: paid.amountIrt,
  });
}

/** Purchase total backing a payout: order amount + applied wallet credit. */
export function referralRewardIrt(totalIrt: number, rewardPercent: number): number {
  if (
    !Number.isSafeInteger(totalIrt) ||
    totalIrt < 1 ||
    !Number.isSafeInteger(rewardPercent) ||
    rewardPercent < 1 ||
    rewardPercent > 100
  ) {
    return 0;
  }
  const product = totalIrt * rewardPercent;
  if (!Number.isSafeInteger(product)) return 0; // never round-trip through imprecise floats
  return Math.floor(product / 100);
}
