/**
 * Phase 15: the one-time free test service (100 MB for 1 day by default —
 * the numbers live ONLY in the settings doc, never in code paths).
 *
 * Business wall: EVERY user gets exactly ONE test EVER — before, during and
 * after expiry. Enforcement is the `free_test_claims` PK (db/freeTest.ts):
 * repeated taps, webhooks replays, two clients racing and a forged direct
 * `tst:claim` callback all converge on the single claim row. UI hiding of the
 * offer is a courtesy; the DB decides.
 *
 * The test order is an ordinary 'purchase' order BORN 'approved' (the exact
 * wallet-full-paid precedent): no receipt, no admin queue, no payment
 * reminders — then the SAME provisioning funnel creates it on the panel, so
 * the whole claim→pre-check→create→verify→adopt discipline applies unchanged.
 * Referral payout is deliberately NOT wired here: a zero-amount order must
 * never mint referrer rewards.
 */
import type { UpdateContext } from '../types.ts';
import { freeTestAvailable } from '../catalog/freeTest.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import {
  claimFreeTest,
  getFreeTestClaim,
  insertFreeTestOrder,
  releaseFreeTestClaim,
} from '../db/freeTest.ts';
import { getOrderById } from '../db/orders.ts';
import { randomConfigName } from '../lib/configName.ts';
import { provisionOrder } from '../provision/provision.ts';
import { freeTestKeyboard, serviceNoticeKeyboard } from '../telegram/menu.ts';
import type { Ui } from '../telegram/i18n.ts';

function offerCopy(ui: Ui, volumeMb: number, durationDays: number): string {
  return ui.t.freeTestOffer(ui.f.digits(volumeMb), ui.f.dayCount(durationDays));
}

/**
 * Offer gating for the two CTA surfaces (first-ever /start, My Services
 * empty). Fail-closed by construction: a missing/malformed/disabled doc, a
 * commercial stop or an existing claim all mean NO offer, no error, no
 * writes of any kind — the surfaces just render as before.
 */
async function freeTestOfferEligible(ctx: UpdateContext): Promise<string | null> {
  const loaded = await freeTestAvailable(ctx.db);
  if (!loaded.ok) return null;
  if (await isSalesStopped(ctx.db)) return null;
  const claim = await getFreeTestClaim(ctx.db, ctx.customerId);
  if (claim !== null) return null;
  return offerCopy(ctx.ui, loaded.config.volumeMb, loaded.config.durationDays);
}

/** The dedicated offer bubble for the FIRST-ever /start (own message: one
 *  markup per Telegram message, and the main menu keyboard is untouchable). */
export async function maybeOfferFreeTestOnStart(ctx: UpdateContext): Promise<void> {
  const offer = await freeTestOfferEligible(ctx);
  if (offer === null) return;
  await ctx.api.sendMessage(ctx.chatId, offer, freeTestKeyboard(ctx.ui));
}

/** My Services empty state: same offer, one compact line + CTA keyboard. */
export async function freeTestEmptyStateOffer(
  ctx: UpdateContext,
): Promise<string | null> {
  const loaded = await freeTestAvailable(ctx.db);
  if (!loaded.ok) return null;
  if (await isSalesStopped(ctx.db)) return null;
  if ((await getFreeTestClaim(ctx.db, ctx.customerId)) !== null) return null;
  return ctx.ui.t.freeTestCta(
    ctx.ui.f.digits(loaded.config.volumeMb),
    ctx.ui.f.dayCount(loaded.config.durationDays),
  );
}

/** Provision after the born-approved insert, deferred past the webhook ACK
 *  exactly like the wallet-paid purchase path. NO referral payout on tests. */
async function afterTestOrderApproved(ctx: UpdateContext, orderId: string): Promise<void> {
  const run = provisionOrder(
    { env: ctx.env, db: ctx.db, api: ctx.api },
    { orderId },
  ).then((outcome) => {
    if (!outcome.ok && 'skip' in outcome) {
      console.log(`free_test_provision_skipped orderId=${orderId.slice(0, 32)} reason=${outcome.skip}`);
    }
    return outcome;
  });
  if (ctx.waitUntil) ctx.waitUntil(run);
  else await run;
}

/**
 * `tst:claim` — the ONLY write surface of the feature. Works from any session
 * state (it never reads or clears sessions: there is no draft ladder behind a
 * test claim, so /cancel semantics cannot be entangled with it).
 *
 * Every outcome funnels through the SAME (claim → idempotent order insert →
 * idempotent provision) sequence keyed on the claim's stored order id, so a
 * fresh win, a mid-race loser and the survivor of a crash-recovery all
 * converge on exactly one test order and one panel service.
 */
export async function claimFreeTestTap(
  ctx: UpdateContext,
  callbackQueryId: string,
): Promise<void> {
  const t = ctx.ui.t;
  const { db } = ctx;

  const loaded = await freeTestAvailable(db);
  if (!loaded.ok) {
    // Phase 23: an admin-stopped test gets the friendly stopped notice as a
    // readable bubble (every other failure keeps the neutral toast).
    if (loaded.error === 'free_test:disabled') {
      await ctx.api.answerCallbackQuery(callbackQueryId);
      await ctx.api.sendMessage(ctx.chatId, t.freeTestStoppedNotice);
      return;
    }
    await ctx.api.answerCallbackQuery(callbackQueryId, t.freeTestUnavailable, true);
    return;
  }
  // Phase 13 semantics: the stop covers NEW panel creations — a free test
  // consumes the same capacity, so it is gated like purchases (and gated
  // BEFORE the claim: a stopped tap must never burn the once-ever wall).
  if (await isSalesStopped(db)) {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(ctx.chatId, t.salesStoppedNotice);
    return;
  }

  const claim = await claimFreeTest(db, ctx.customerId);
  if (claim.kind === 'error') {
    await ctx.api.answerCallbackQuery(callbackQueryId, t.freeTestUnavailable, true);
    return;
  }
  const isNewClaim = claim.kind === 'won';
  const orderId = claim.orderId;

  const snapshot = JSON.stringify({
    schema: 1,
    free_test: true, // immutable class marker (display + provisioning path)
    config_name: randomConfigName(),
    volume_mb: loaded.config.volumeMb,
    duration_days: loaded.config.durationDays,
    device_count: loaded.config.deviceCount,
  });
  const inserted = await insertFreeTestOrder(db, {
    orderId,
    customerId: ctx.customerId,
    selections: snapshot,
  });
  if (inserted.kind === 'error') {
    // A confirmed failure releases ONLY a claim THIS execution just minted
    // (guarded DELETE), so a brand-new user can retry; a pre-existing claim
    // is left intact — we never roll back someone else's once-ever wall.
    if (isNewClaim) await releaseFreeTestClaim(db, ctx.customerId, orderId);
    await ctx.api.answerCallbackQuery(callbackQueryId, t.freeTestUnavailable, true);
    return;
  }

  // Fresh green path (won the claim AND created the order): celebrate, then
  // provision. Every other combination re-reads the durable order and answers
  // honestly by its CURRENT state (never promising a send that already ran).
  if (isNewClaim && inserted.kind === 'created') {
    await ctx.api.answerCallbackQuery(callbackQueryId, t.freeTestQueuedToast);
    await ctx.api.sendMessage(ctx.chatId, t.freeTestCreated(orderId));
    await afterTestOrderApproved(ctx, orderId);
    return;
  }
  await respondClaimed(ctx, orderId, callbackQueryId);
}

/**
 * A tap whose claim predates it (already claimed / mid-race loser / crash
 * survivor). The order under the stored id is authoritative; 'approved' is
 * re-poked through provisioning (guarded, cheap — no double send), while
 * 'failed' is left to the admin /failed retry exactly like paid orders.
 */
async function respondClaimed(
  ctx: UpdateContext,
  claimOrderId: string,
  callbackQueryId: string,
): Promise<void> {
  const t = ctx.ui.t;
  const order = await getOrderById(ctx.db, claimOrderId);
  if (!order || order.customer_id !== ctx.customerId) {
    // The claim row carried an order id with no matching row AND the customer
    // check failing is structurally impossible; fail CLOSED, no writes.
    await ctx.api.answerCallbackQuery(callbackQueryId, t.freeTestUnavailable, true);
    return;
  }
  if (order.state === 'completed') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(
      ctx.chatId,
      t.freeTestAlready,
      serviceNoticeKeyboard(ctx.ui, order.id),
    );
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await ctx.api.sendMessage(ctx.chatId, t.freeTestWait);
  if (order.state === 'approved') {
    // The order was never provisioned (skip/crash): the claim's guarded
    // approved→provisioning UPDATE makes this re-poke converge, not stack.
    await afterTestOrderApproved(ctx, order.id);
  }
}
