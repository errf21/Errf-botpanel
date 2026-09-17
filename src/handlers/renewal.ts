/**
 * Renewal / service-increase ladder:
 *   WAITING_RENEWAL_DURATION → WAITING_RENEWAL_VOLUME → WAITING_RENEWAL_CONFIRMATION
 *   → (via the SHARED receipt/provisioning pipeline) WAITING_PAYMENT_RECEIPT.
 *
 * Supports duration-only, volume-only, and duration + volume. Duration `0`
 * means "no time extension", volume `0` means "no increase"; both zero is
 * rejected. Volume pricing reuses the shared purchase rate
 * (`volumeExtraCost`); quota reuses the purchase `GB_BYTES` conversion
 * additively in provisioning (never here).
 *
 * Hard rules inherited from the purchase flow:
 *  - Keyboard values are never trusted: every tap is re-validated against
 *    the FRESH catalog (duration presets, `acceptVolume` for add-ons).
 *  - Ownership, "one active renewal at a time" and the renewal kill switch
 *    are re-checked at START, at each STEP, at SUMMARY render and at CONFIRM.
 *  - Confirmation is idempotent (token → checkout): a replay delivers the
 *    same renewal order, never a second one.
 */
import type { Session } from '../db/states.ts';
import type { UpdateContext } from '../types.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { acceptVolume, enabledDurationDays, loadCatalog } from '../catalog/catalog.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { calculateRenewalPrice } from '../catalog/pricing.ts';
import { checkoutRenewalOrder } from '../orders/checkout.ts';
import { newOrderId } from '../lib/security.ts';
import { isValidOrderId, parsePositiveInt } from '../lib/validate.ts';
import { setSession, clearSession } from '../db/states.ts';
import { findActiveRenewalForService, findActiveRepurchaseForService, getOwnedService } from '../db/orders.ts';
import type { OrderRow } from '../db/orders.ts';
import { isFreeTestOrder } from '../db/freeTest.ts';
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
import { renewalDurationKeyboard, renewalVolumeKeyboard, confirmKeyboard, backToMenuKeyboard, walletPayKeyboard } from '../telegram/menu.ts';
import { payableWalletBalance } from './wallet.ts';
import { payOrderWithWallet, refundOrderWalletPayment, setPaidLedgerOrder } from '../db/wallet.ts';
import { planWalletPayment, type WalletPlan } from '../orders/checkout.ts';

import { sendPaymentInstructions } from './payment.ts';
import { reduce } from '../state/machine.ts';

const DAY_MS = 86_400_000;

/** Shortcut add-on buttons; each is still validated via `acceptVolume`. */
const RENEWAL_VOLUME_SHORTCUTS = [10, 20, 30];

/** Reusable guard: owned completed service + renewals enabled + none active. */
async function renewableService(
  ctx: UpdateContext,
  serviceOrderId: string,
): Promise<{ ok: true; service: OrderRow } | { ok: false; toast: string; clearSession?: boolean }> {
  // Phase 13: a renewal EXTENDS a paid service, so the commercial stop covers
  // it too — checked first, long before any wallet debit (confirmRenewal
  // claims credit only after this guard) or checkout (backstop below).
  if (await isSalesStopped(ctx.db)) {
    return { ok: false, toast: ctx.ui.t.salesStoppedNotice };
  }
  const renewal = await loadRenewalViewConfig(ctx.db);
  if (!renewal.enabled) {
    return { ok: false, toast: ctx.ui.t.renewDisabledNotice };
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    return { ok: false, toast: ctx.ui.t.serviceNotFound, clearSession: true };
  }
  // Phase 15: a free test is never renewable — enforced from the claims table
  // (DB-authoritative), so a forged/hand-edited selections blob can't change
  // the class. The renew button is already hidden in the detail keyboard.
  if (await isFreeTestOrder(ctx.db, service.id)) {
    return { ok: false, toast: ctx.ui.t.renewNotForFreeTest };
  }
  const active = await findActiveRenewalForService(ctx.db, service.id);
  if (active !== null) {
    return { ok: false, toast: ctx.ui.t.renewInProgressNotice(active.id.slice(0, 10)) };
  }
  // Phase 18 cross-guard: one lifecycle operation at a time — an in-flight
  // repurchase blocks a new renewal (and vice versa in repurchase.ts).
  // Tolerant of pre-0019 schemas (finder returns null there).
  const activeRepurchase = await findActiveRepurchaseForService(ctx.db, service.id);
  if (activeRepurchase !== null) {
    return { ok: false, toast: ctx.ui.t.repInProgressNotice(activeRepurchase.id.slice(0, 10)) };
  }
  return { ok: true, service };
}

export function renewalVolumePresets(catalog: Catalog): number[] {
  return RENEWAL_VOLUME_SHORTCUTS.filter((gb) => acceptVolume(catalog, gb).ok);
}

export async function sendRenewalDurationPrompt(
  ctx: UpdateContext,
  service: OrderRow,
  catalog: Catalog,
): Promise<void> {
  const presets = enabledDurationDays(catalog);
  const name = serviceSnapshotData(service).name ?? ctx.ui.t.accountNone;
  const intro = ctx.ui.t.renewIntro(name, expiryDisplay(ctx.ui, effectiveExpiryIso(service)));
  await ctx.api.sendMessage(
    ctx.chatId,
    `${intro}\n\n${ctx.ui.t.renewDurationPrompt}`,
    renewalDurationKeyboard(ctx.ui, presets),
  );
}

export async function sendRenewalVolumePrompt(
  ctx: UpdateContext,
  service: OrderRow,
  catalog: Catalog,
): Promise<void> {
  const name = serviceSnapshotData(service).name ?? ctx.ui.t.accountNone;
  const intro = ctx.ui.t.renewIntro(name, expiryDisplay(ctx.ui, effectiveExpiryIso(service)));
  await ctx.api.sendMessage(
    ctx.chatId,
    `${intro}\n\n${ctx.ui.t.renewVolumePrompt}`,
    renewalVolumeKeyboard(ctx.ui, renewalVolumePresets(catalog), catalog.volume.allowCustom),
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
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.serviceBusyFirst, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    return;
  }
  const loaded = await loadCatalog(ctx.db);
  if (!loaded.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.catalogUnavailable, true);
    return;
  }
  const next = reduce(session.state, 'renew_start');
  if (next !== 'WAITING_RENEWAL_DURATION') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, { renews_order_id: serviceOrderId });
  await sendRenewalDurationPrompt(ctx, guard.service, loaded.catalog);
}

/** `dur:` choice while WAITING_RENEWAL_DURATION — presets plus `0` (skip). */
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
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  if (days !== 0 && !enabledDurationDays(catalog).includes(days)) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.rejectedPresetDisabled, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const next = reduce(session.state, 'renew_duration_chosen');
  if (next !== 'WAITING_RENEWAL_VOLUME') return;
  const data: Session['data'] = { ...session.data, duration_days: days };
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, data);
  await sendRenewalVolumePrompt(ctx, guard.service, catalog);
}

/** `vol:` choice while WAITING_RENEWAL_VOLUME — shortcuts plus `0` (skip). */
export async function applyRenewalVolume(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  gb: number,
  callbackQueryId: string,
): Promise<void> {
  const serviceOrderId = session.data['renews_order_id'];
  const days = session.data['duration_days'];
  if (
    session.state !== 'WAITING_RENEWAL_VOLUME' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId) ||
    typeof days !== 'number'
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  if (gb !== 0 && !acceptVolume(catalog, gb).ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.rejectedPresetDisabled, true);
    return;
  }
  if (days === 0 && gb === 0) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.renewEmptyError, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const next = reduce(session.state, 'renew_volume_chosen');
  if (next !== 'WAITING_RENEWAL_CONFIRMATION') return;
  const data: Session['data'] = { ...session.data, added_volume_gb: gb };
  if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, data);
  await sendRenewalSummary(ctx, { state: next, data }, catalog, guard.service);
}

/** Typed custom add-on volume while WAITING_RENEWAL_VOLUME (purchase limits). */
export async function applyRenewalCustomVolume(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  rawText: string,
): Promise<void> {
  const serviceOrderId = session.data['renews_order_id'];
  const days = session.data['duration_days'];
  if (
    session.state !== 'WAITING_RENEWAL_VOLUME' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId) ||
    typeof days !== 'number'
  ) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.staleChoice, backToMenuKeyboard(ctx.ui));
    return;
  }
  const value = parsePositiveInt(rawText);
  if (value === null) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.rejectedNotWhole, backToMenuKeyboard(ctx.ui));
    return;
  }
  const check = acceptVolume(catalog, value);
  if (!check.ok) {
    if (check.reason === 'range') {
      await ctx.api.sendMessage(
        ctx.chatId,
        ctx.ui.t.rejectedVolumeRange(value, catalog.volume.minGb, catalog.volume.maxGb),
        backToMenuKeyboard(ctx.ui),
      );
    } else {
      await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.rejectedPresetDisabled, backToMenuKeyboard(ctx.ui));
    }
    return;
  }
  if (days === 0 && value === 0) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.renewEmptyError, backToMenuKeyboard(ctx.ui));
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.sendMessage(ctx.chatId, guard.toast, backToMenuKeyboard(ctx.ui));
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const next = reduce(session.state, 'renew_volume_chosen');
  if (next !== 'WAITING_RENEWAL_CONFIRMATION') return;
  const data: Session['data'] = { ...session.data, added_volume_gb: value };
  if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
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
  const addedGb = session.data['added_volume_gb'] ?? 0;
  const token = session.data['order_token'];
  if (typeof days !== 'number' || typeof addedGb !== 'number' || typeof token !== 'string') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.missingDraftData, backToMenuKeyboard(ctx.ui));
    return;
  }
  if (days === 0 && addedGb === 0) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.renewEmptyError, backToMenuKeyboard(ctx.ui));
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days, addedVolumeGb: addedGb });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const b = computed.breakdown;
  const localExpiry = effectiveExpiryIso(service);
  const baseMs = Math.max(
    Date.now(),
    localExpiry === null ? 0 : Date.parse(localExpiry),
  );
  const newExpiryIso = days > 0 ? new Date(baseMs + b.duration_days * DAY_MS).toISOString() : null;
  const name = serviceSnapshotData(service).name ?? ctx.ui.t.accountNone;
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  const lines = [
    ctx.ui.t.renewSummaryHeader,
    ctx.ui.t.renewSummaryService(name),
    b.months > 0 ? ctx.ui.t.renewSummaryAdd(b.months) : ctx.ui.t.renewSummaryNoTime,
    addedGb > 0 ? ctx.ui.t.renewSummaryVolume(addedGb) : ctx.ui.t.renewSummaryNoVolume,
    ctx.ui.t.summaryPrice(ctx.ui.f.price(b.total, b.currency)),
    ctx.ui.t.renewSummaryFrom(expiryDisplay(ctx.ui, localExpiry)),
    ...(newExpiryIso !== null ? [ctx.ui.t.renewSummaryUntil(expiryDisplay(ctx.ui, newExpiryIso))] : []),
    ctx.ui.t.summaryId(token),
  ];
  if (balance !== null && balance > 0) {
    lines.push(ctx.ui.t.summaryWalletLine(ctx.ui.f.price(balance, 'IRT')));
    const full = balance >= b.total;
    const partial = !full && balance >= 1 && b.total >= 2;
    lines.push(ctx.ui.t.summaryHint);
    await ctx.api.sendMessage(
      ctx.chatId,
      lines.join('\n\n'),
      full || partial ? walletPayKeyboard(ctx.ui, partial) : confirmKeyboard(ctx.ui),
    );
    return;
  }
  lines.push(ctx.ui.t.summaryHint);
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), confirmKeyboard(ctx.ui));
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
  const addedGb = session.data['added_volume_gb'] ?? 0;
  const serviceOrderId = session.data['renews_order_id'];
  if (
    session.state !== 'WAITING_RENEWAL_CONFIRMATION' ||
    typeof token !== 'string' ||
    typeof days !== 'number' ||
    typeof addedGb !== 'number' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice);
    return;
  }
  if (days === 0 && addedGb === 0) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.renewEmptyError, true);
    return;
  }
  const guard = await renewableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days, addedVolumeGb: addedGb });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  const snapshotName = serviceSnapshotData(guard.service).name ?? ctx.ui.t.accountNone;
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
        paid.reason === 'insufficient' ? ctx.ui.t.walletBalanceLow : ctx.ui.t.catalogUnavailable,
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
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (wallet && wallet.mode === 'full') {
    if (!result.created) {
      // Replay token: the order exists — never pay or re-provision again.
      const fresh = await getOrderByIdForReplay(ctx.db, result.order.id);
      await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.alreadyConfirmed, true);
      await ctx.api.sendMessage(
        ctx.chatId,
        fresh ? ctx.ui.t.paymentWaitNotice : ctx.ui.t.alreadyConfirmed,
        backToMenuKeyboard(ctx.ui),
      );
      if (fresh) await sendPaymentInstructions(ctx, fresh);
      return;
    }
    // Debit already claimed against the TOKEN before checkout (single
    // payment path); re-point the ledger onto the created approved row.
    await setPaidLedgerOrder(ctx.db, token, result.order.id);
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.walletPayConfirmToast);
    await ctx.api.sendMessage(
      ctx.chatId,
      ctx.ui.t.walletPaidRenewal(result.order.id, ctx.ui.f.price(wallet.creditIrt, 'IRT')),
      backToMenuKeyboard(ctx.ui),
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
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.alreadyConfirmed, true);
    await ctx.api.sendMessage(
      ctx.chatId,
      fresh ? ctx.ui.t.paymentWaitNotice : ctx.ui.t.alreadyConfirmed,
      backToMenuKeyboard(ctx.ui),
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
    result.created ? ctx.ui.t.orderConfirmToast : ctx.ui.t.alreadyConfirmed,
    !result.created,
  );
  if (result.created && wallet && wallet.mode === 'partial') {
    await setPaidLedgerOrder(ctx.db, token, result.order.id);
    {
      await ctx.api.sendMessage(
        ctx.chatId,
        ctx.ui.t.walletPartialRenewal(
          result.order.id,
          ctx.ui.f.price(wallet.creditIrt, 'IRT'),
          ctx.ui.f.price(result.order.amount, result.order.currency),
        ),
        backToMenuKeyboard(ctx.ui),
      );
    }
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    ctx.ui.t.renewConfirmed(result.order.id),
    backToMenuKeyboard(ctx.ui),
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
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const days = session.data['duration_days'];
  const addedGb = session.data['added_volume_gb'] ?? 0;
  if (session.state !== 'WAITING_RENEWAL_CONFIRMATION' || typeof days !== 'number' || typeof addedGb !== 'number') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  const computed = calculateRenewalPrice(catalog.pricing, { durationDays: days, addedVolumeGb: addedGb });
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const plan = planWalletPayment(computed.breakdown.total, balance, mode);
  if (!plan) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.walletBalanceLow, backToMenuKeyboard(ctx.ui));
    return;
  }
  await confirmRenewal(ctx, session, catalog, callbackQueryId, plan);
}

/** `step:back` inside the renewal ladder (volume → duration → services list). */
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
  if (session.state !== 'WAITING_RENEWAL_VOLUME' && session.state !== 'WAITING_RENEWAL_CONFIRMATION') {
    return 'not-renewal';
  }
  const serviceOrderId = session.data['renews_order_id'];
  await ctx.api.answerCallbackQuery(callbackQueryId);
  if (typeof serviceOrderId !== 'string' || !isValidOrderId(serviceOrderId)) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.missingDraftData, backToMenuKeyboard(ctx.ui));
    return 'handled';
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.serviceNotFound, backToMenuKeyboard(ctx.ui));
    return 'handled';
  }
  const next = reduce(session.state, 'step_back');
  await setSession(ctx.db, ctx.customerId, next, { ...session.data });
  if (next === 'WAITING_RENEWAL_DURATION') {
    await sendRenewalDurationPrompt(ctx, service, catalog);
  } else {
    await sendRenewalVolumePrompt(ctx, service, catalog);
  }
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
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.missingDraftData, backToMenuKeyboard(ctx.ui));
    return;
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.serviceNotFound, backToMenuKeyboard(ctx.ui));
    return;
  }
  if (session.state === 'WAITING_RENEWAL_DURATION') {
    await sendRenewalDurationPrompt(ctx, service, catalog);
    return;
  }
  if (session.state === 'WAITING_RENEWAL_VOLUME') {
    await sendRenewalVolumePrompt(ctx, service, catalog);
    return;
  }
  if (session.state === 'WAITING_RENEWAL_CONFIRMATION') {
    await sendRenewalSummary(ctx, session, catalog, service);
  }
}
