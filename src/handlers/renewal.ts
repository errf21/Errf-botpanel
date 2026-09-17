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
import { acceptVolume, enabledDurationDays } from '../catalog/catalog.ts';
import { calculateRenewalPrice } from '../catalog/pricing.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { setSession, clearSession } from '../db/states.ts';
import { getOwnedService } from '../db/orders.ts';
import type { OrderRow } from '../db/orders.ts';
import { serviceSnapshotData, effectiveExpiryIso, expiryDisplay, showMyServices } from './services.ts';
import { renewalDurationKeyboard, renewalVolumeKeyboard, confirmKeyboard, backToMenuKeyboard, walletPayKeyboard } from '../telegram/menu.ts';
import { payableWalletBalance } from './wallet.ts';
import { type WalletPlan } from '../orders/checkout.ts';

import { reduce } from '../state/machine.ts';

const DAY_MS = 86_400_000;

/** Shortcut add-on buttons; each is still validated via `acceptVolume`. */
const RENEWAL_VOLUME_SHORTCUTS = [10, 20, 30];

/**
 * Phase 19: renewal is RETIRED for every paid service — repurchase replaced
 * it. The entry points below answer with the retired notice and perform ZERO
 * session/catalog/wallet/checkout writes, so no new renewal draft or order
 * can be created from any callback or message. Already-created renewal
 * ORDERS still finish through the shared admin/provisioning pipeline, and
 * history rendering is untouched.
 *
 * NOTE: the former `renewableService` entry guard was deleted with the
 * retirement — there is no renewal entry path left to guard. The
 * renewal↔repurchase mutual exclusion now lives entirely in
 * `repurchasableService` (repurchase.ts) plus the hidden UI.
 */
async function answerRetired(ctx: UpdateContext, callbackQueryId: string): Promise<void> {
  await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.renewRetiredNotice, true);
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

/** `svc:rnw` — RETIRED in Phase 19 (repurchase replaced renewal everywhere).
 * Kept as a named handler so stale buttons resolve here instead of falling
 * through; it answers the retired notice and writes nothing. */
export async function startRenewal(
  ctx: UpdateContext,
  _session: Session,
  _serviceOrderId: string,
  callbackQueryId: string,
): Promise<void> {
  await answerRetired(ctx, callbackQueryId);
}

/** `dur:` choice while WAITING_RENEWAL_DURATION — RETIRED in Phase 19. */
export async function applyRenewalDuration(
  ctx: UpdateContext,
  _session: Session,
  _catalog: Catalog,
  _days: number,
  callbackQueryId: string,
): Promise<void> {
  // Phase 19 RETIRED — see answerRetired.
  await answerRetired(ctx, callbackQueryId);
}

/** `vol:` choice while WAITING_RENEWAL_VOLUME — RETIRED in Phase 19. */
export async function applyRenewalVolume(
  ctx: UpdateContext,
  _session: Session,
  _catalog: Catalog,
  _gb: number,
  callbackQueryId: string,
): Promise<void> {
  // Phase 19 RETIRED — see answerRetired.
  await answerRetired(ctx, callbackQueryId);
}

/** Typed custom add-on volume while WAITING_RENEWAL_VOLUME — RETIRED in Phase 19. */
export async function applyRenewalCustomVolume(
  ctx: UpdateContext,
  _session: Session,
  _catalog: Catalog,
  _rawText: string,
): Promise<void> {
  // Phase 19 RETIRED — see answerRetired.
  await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.renewRetiredNotice, backToMenuKeyboard(ctx.ui));
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

/** `ord:confirm` while WAITING_RENEWAL_CONFIRMATION — RETIRED in Phase 19.
 * No renewal order can be created anymore; already-created renewal ORDERS
 * still finish via the shared admin/provisioning pipeline. */
export async function confirmRenewal(
  ctx: UpdateContext,
  _session: Session,
  _catalog: Catalog,
  callbackQueryId: string,
  _wallet: WalletPlan | null = null,
): Promise<void> {
  // Phase 19 RETIRED — see answerRetired.
  await answerRetired(ctx, callbackQueryId);
}

/** `wlt:full|wlt:part` while WAITING_RENEWAL_CONFIRMATION — RETIRED in Phase 19. */
export async function confirmRenewalWithWallet(
  ctx: UpdateContext,
  _session: Session,
  _catalog: Catalog,
  _mode: 'full' | 'partial',
  callbackQueryId: string,
): Promise<void> {
  // Phase 19 RETIRED — see answerRetired.
  await answerRetired(ctx, callbackQueryId);
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
