/**
 * Phase 6 renewal ladder: WAITING_RENEWAL_DURATION → WAITING_RENEWAL_CONFIRMATION
 * → (via the SHARED receipt/provisioning pipeline) WAITING_PAYMENT_RECEIPT.
 *
 * Hard rules inherited from the purchase flow:
 *  - Keyboard values are never trusted: the renewal duration is re-validated
 *    against the FRESH catalog on every tap, and ONLY month presets pass
 *    (custom values are structurally impossible in this ladder).
 *  - Ownership, "one active renewal at a time" and the renewal kill switch
 *    are re-checked at START, at SUMMARY render and at CONFIRM.
 *  - Confirmation is idempotent (token → checkout): a replay delivers the
 *    same renewal order, never a second one.
 */
import type { Session } from '../db/states.ts';
import type { UpdateContext } from '../types.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { enabledDurationDays, loadCatalog } from '../catalog/catalog.ts';
import { calculateRenewalPrice } from '../catalog/pricing.ts';
import { checkoutRenewalOrder } from '../orders/checkout.ts';
import { newOrderId } from '../lib/security.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { setSession, clearSession } from '../db/states.ts';
import { findActiveRenewalForService, getOwnedService } from '../db/orders.ts';
import type { OrderRow } from '../db/orders.ts';
import { provisionOrder } from '../provision/provision.ts';
import { getOrderById, findOrderByIdempotencyKey } from '../db/orders.ts';

async function getOrderByIdForReplay(db: D1Database, orderId: string) {
  try {
    return await getOrderById(db, orderId);
  } catch {
    return null;
  }
}

async function findOrderByIdempotencyKeySoft(db: D1Database, token: string) {
  try {
    return await findOrderByIdempotencyKey(db, token);
  } catch {
    return undefined;
  }
}
import { loadRenewalViewConfig, serviceSnapshotData, effectiveExpiryIso, expiryDisplay, showMyServices } from './services.ts';
import { renewalDurationKeyboard, confirmKeyboard, backToMenuKeyboard, walletPayKeyboard } from '../telegram/menu.ts';
import { payableWalletBalance } from './wallet.ts';
import { payOrderWithWallet, refundOrderWalletPayment, setPaidLedgerOrder } from '../db/wallet.ts';
import { planWalletPayment, type WalletPlan } from '../orders/checkout.ts';
import { fa, formatPrice } from '../telegram/texts.ts';
import { sendPaymentInstructions } from './payment.ts';
import { reduce } from '../state/machine.ts';

const DAY_MS = 86_400_000;

/** Reusable guard: owned completed service + renewals enabled + none active. */
async function renewableService(
  ctx: UpdateContext,
  serviceOrderId: string,
): Promise<{ ok: true; service: OrderRow } | { ok: false; toast: string; clearSession?: boolean }> {
  const renewal = await loadRenewalViewConfig(ctx.db);
  if (!renewal.enabled) {
    return { ok: false, toast: fa.renewDisabledNotice };
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    return { ok: false, toast: fa.serviceNotFound, clearSession: true };
  }
  const active = await findActiveRenewalForService(ctx.db, service.id);
  if (active !== null) {
    return { ok: false, toast: fa.renewInProgressNotice(active.id.slice(0, 10)) };
  }
  return { ok: true, service };
}

export async function sendRenewalDurationPrompt(
  ctx: UpdateContext,
  service: OrderRow,
  catalog: Catalog,
): Promise<void> {
  const presets = enabledDurationDays(catalog);
  const name = serviceSnapshotData(service).name ?? fa.accountNone;
  const intro = fa.renewIntro(name, expiryDisplay(effectiveExpiryIso(service)));
  await ctx.api.sendMessage(
    ctx.chatId,
    `${intro}\n\n${fa.renewDurationPrompt}`,
    renewalDurationKeyboard(presets),
  );
}

/** `svc:rnw` — IDLE-only entry into the renewal ladder. */
export async function startRenewal(
  ctx: UpdateContext,
  session: Session,
  serviceOrderId: string,
  callbackQueryId: string,
): Promise<void> {
  if (session.state !== 'IDLE') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.serviceBusyFirst, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    return;
  }
  const loaded = await loadCatalog(ctx.db);
  if (!loaded.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.catalogUnavailable, true);
    return;
  }
  const next = reduce(session.state, 'renew_start');
  if (next !== 'WAITING_RENEWAL_DURATION') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.invalidChoice);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, { renews_order_id: serviceOrderId });
  await sendRenewalDurationPrompt(ctx, guard.service, loaded.catalog);
}

/** `dur:` choice while WAITING_RENEWAL_DURATION — preset months only. */
export async function applyRenewalDuration(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  days: number,
  callbackQueryId: string,
): Promise<void> {
  const serviceOrderId = session.data['renews_order_id'];
  if (
    session.state !== 'WAITING_RENEWAL_DURATION' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.staleChoice, true);
    return;
  }
  if (!enabledDurationDays(catalog).includes(days)) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.rejectedPresetDisabled, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const next = reduce(session.state, 'renew_duration_chosen');
  if (next !== 'WAITING_RENEWAL_CONFIRMATION') return;
  const data: Session['data'] = { ...session.data, duration_days: days };
  if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, data);
  await sendRenewalSummary(ctx, { state: next, data }, catalog, guard.service);
}

/** Renders the renewal summary strictly from server-side data. */
export async function sendRenewalSummary(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  service: OrderRow,
): Promise<void> {
  const days = session.data['duration_days'];
  const token = session.data['order_token'];
  if (typeof days !== 'number' || typeof token !== 'string') {
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, backToMenuKeyboard());
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  const b = computed.breakdown;
  const localExpiry = effectiveExpiryIso(service);
  const baseMs = Math.max(
    Date.now(),
    localExpiry === null ? 0 : Date.parse(localExpiry),
  );
  const newExpiryIso = new Date(baseMs + b.duration_days * DAY_MS).toISOString();
  const name = serviceSnapshotData(service).name ?? fa.accountNone;
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  const lines = [
    fa.renewSummaryHeader,
    fa.renewSummaryService(name),
    fa.renewSummaryAdd(b.months),
    fa.summaryPrice(formatPrice(b.total, b.currency)),
    fa.renewSummaryFrom(expiryDisplay(localExpiry)),
    fa.renewSummaryUntil(expiryDisplay(newExpiryIso)),
    fa.summaryId(token),
  ];
  if (balance !== null && balance > 0) {
    lines.push(fa.summaryWalletLine(formatPrice(balance, 'IRT')));
    const full = balance >= b.total;
    const partial = !full && balance >= 1 && b.total >= 2;
    lines.push(fa.summaryHint);
    await ctx.api.sendMessage(
      ctx.chatId,
      lines.join('\n\n'),
      full || partial ? walletPayKeyboard(partial) : confirmKeyboard(),
    );
    return;
  }
  lines.push(fa.summaryHint);
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), confirmKeyboard());
}

/** `ord:confirm` while WAITING_RENEWAL_CONFIRMATION — the renewal's only exit. */
export async function confirmRenewal(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
  wallet: WalletPlan | null = null,
): Promise<void> {
  const token = session.data['order_token'];
  const days = session.data['duration_days'];
  const serviceOrderId = session.data['renews_order_id'];
  if (
    session.state !== 'WAITING_RENEWAL_CONFIRMATION' ||
    typeof token !== 'string' ||
    typeof days !== 'number' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.staleChoice);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  const snapshotName = serviceSnapshotData(guard.service).name ?? fa.accountNone;
  if (wallet) {
    const paid = await payOrderWithWallet(ctx.db, {
      customerId: ctx.customerId,
      amountIrt: wallet.creditIrt,
      orderId: token,
      actor: 'customer',
    });
    if (!paid.ok) {
      await ctx.api.answerCallbackQuery(
        callbackQueryId,
        paid.reason === 'insufficient' ? fa.walletBalanceLow : fa.catalogUnavailable,
        true,
      );
      return;
    }
  }
  const result = await checkoutRenewalOrder(
    ctx.db,
    {
      customerId: ctx.customerId,
      orderToken: token,
      catalog,
      breakdown: computed.breakdown,
      serviceOrderId: guard.service.id,
    },
    snapshotName,
    wallet ?? undefined,
  );
  if (!result.ok) {
    console.error(`renewal_checkout_failed error=${result.error.slice(0, 60)}`);
    // Wallet money was already claimed on the draft token. Race with an
    // earlier checkout? Then THAT row owns the paid money — refund ONLY
    // when no order exists for this token at all (same discipline as
    // purchase.ts; refundOrderWalletPayment is claim-row exactly-once, so
    // retries can never credit twice).
    if (wallet) {
      const orphan = await findOrderByIdempotencyKeySoft(ctx.db, token);
      if (orphan === null) {
        await refundOrderWalletPayment(ctx.db, {
          customerId: ctx.customerId,
          orderId: token,
          actor: 'customer',
        }).catch(() => undefined);
      }
    }
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (wallet && wallet.mode === 'full') {
    if (!result.created) {
      // Replay token: the order exists — never pay or re-provision again.
      const fresh = await getOrderByIdForReplay(ctx.db, result.order.id);
      await ctx.api.answerCallbackQuery(callbackQueryId, fa.alreadyConfirmed, true);
      await ctx.api.sendMessage(
        ctx.chatId,
        fresh ? fa.paymentWaitNotice : fa.alreadyConfirmed,
        backToMenuKeyboard(),
      );
      if (fresh) await sendPaymentInstructions(ctx, fresh);
      return;
    }
    // Debit already claimed against the TOKEN before checkout (single
    // payment path); re-point the ledger onto the created approved row.
    await setPaidLedgerOrder(ctx.db, token, result.order.id);
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.walletPayConfirmToast);
    await ctx.api.sendMessage(
      ctx.chatId,
      fa.walletPaidRenewal(result.order.id, formatPrice(wallet.creditIrt, 'IRT')),
      backToMenuKeyboard(),
    );
    const provisioning = provisionOrder(
      { env: ctx.env, db: ctx.db, api: ctx.api },
      { orderId: result.order.id },
    );
    if (ctx.waitUntil) ctx.waitUntil(provisioning);
    else await provisioning;
    return;
  }
  if (wallet && wallet.mode === 'partial' && !result.created) {
    const fresh = await getOrderByIdForReplay(ctx.db, result.order.id);
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.alreadyConfirmed, true);
    await ctx.api.sendMessage(
      ctx.chatId,
      fresh ? fa.paymentWaitNotice : fa.alreadyConfirmed,
      backToMenuKeyboard(),
    );
    if (fresh) await sendPaymentInstructions(ctx, fresh);
    return;
  }
  const next = reduce(session.state, 'renew_confirmed');
  await setSession(ctx.db, ctx.customerId, next, {
    ...session.data,
    order_id: result.order.id,
  });
  await ctx.api.answerCallbackQuery(
    callbackQueryId,
    result.created ? fa.orderConfirmToast : fa.alreadyConfirmed,
    !result.created,
  );
  if (result.created && wallet && wallet.mode === 'partial') {
    await setPaidLedgerOrder(ctx.db, token, result.order.id);
    {
      await ctx.api.sendMessage(
        ctx.chatId,
        fa.walletPartialRenewal(
          result.order.id,
          formatPrice(wallet.creditIrt, 'IRT'),
          formatPrice(result.order.amount, result.order.currency),
        ),
        backToMenuKeyboard(),
      );
    }
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    fa.renewConfirmed(result.order.id),
    backToMenuKeyboard(),
  );
  await sendPaymentInstructions(ctx, result.order);
}

/** `wlt:full|wlt:part` while WAITING_RENEWAL_CONFIRMATION. */
export async function confirmRenewalWithWallet(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  mode: 'full' | 'partial',
  callbackQueryId: string,
): Promise<void> {
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  if (balance === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletUnavailable, backToMenuKeyboard());
    return;
  }
  const days = session.data['duration_days'];
  if (session.state !== 'WAITING_RENEWAL_CONFIRMATION' || typeof days !== 'number') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.staleChoice, true);
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  const plan = planWalletPayment(computed.breakdown.total, balance, mode);
  if (!plan) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletBalanceLow, backToMenuKeyboard());
    return;
  }
  await confirmRenewal(ctx, session, catalog, callbackQueryId, plan);
}

/** `step:back` from the renewal confirmation → duration ladder step. */
export async function renewalGoBack(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
): Promise<'handled' | 'not-renewal'> {
  // Back from the duration step leaves the ladder entirely → services list.
  if (session.state === 'WAITING_RENEWAL_DURATION') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await clearSession(ctx.db, ctx.customerId);
    await showMyServices(ctx);
    return 'handled';
  }
  if (session.state !== 'WAITING_RENEWAL_CONFIRMATION') return 'not-renewal';
  const serviceOrderId = session.data['renews_order_id'];
  await ctx.api.answerCallbackQuery(callbackQueryId);
  if (typeof serviceOrderId !== 'string' || !isValidOrderId(serviceOrderId)) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, backToMenuKeyboard());
    return 'handled';
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.serviceNotFound, backToMenuKeyboard());
    return 'handled';
  }
  const next = reduce(session.state, 'step_back');
  await setSession(ctx.db, ctx.customerId, next, { ...session.data });
  await sendRenewalDurationPrompt(ctx, service, catalog);
  return 'handled';
}

/**
 * Re-entering the flow while a renewal ladder step is live (menu buy tap or
 * stray text): redraw the CURRENT renewal step, state preserved.
 */
export async function resumeRenewal(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
): Promise<void> {
  const serviceOrderId = session.data['renews_order_id'];
  if (typeof serviceOrderId !== 'string' || !isValidOrderId(serviceOrderId)) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, backToMenuKeyboard());
    return;
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.serviceNotFound, backToMenuKeyboard());
    return;
  }
  if (session.state === 'WAITING_RENEWAL_DURATION') {
    await sendRenewalDurationPrompt(ctx, service, catalog);
    return;
  }
  if (session.state === 'WAITING_RENEWAL_CONFIRMATION') {
    await sendRenewalSummary(ctx, session, catalog, service);
  }
}
