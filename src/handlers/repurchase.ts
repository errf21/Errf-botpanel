/**
 * Phase 18 repurchase ladder (same existing PasarGuard user, reset + reconfigure):
 *   WAITING_REPURCHASE_MODE --repurchase_same--> WAITING_REPURCHASE_CONFIRMATION
 *   WAITING_REPURCHASE_MODE --repurchase_custom--> WAITING_REPURCHASE_VOLUME
 *     --repurchase_volume_chosen--> WAITING_REPURCHASE_DURATION
 *     --repurchase_duration_chosen--> WAITING_REPURCHASE_DEVICE
 *     --repurchase_device_chosen--> WAITING_REPURCHASE_CONFIRMATION
 *   → (via the SHARED receipt/provisioning pipeline) WAITING_PAYMENT_RECEIPT.
 *
 * Mode A ("same") restores the canonical specs from the original completed
 * purchase snapshot. Mode B ("custom") collects ABSOLUTE finals with the
 * purchase validators/keyboards (volume/duration/device); the selected volume
 * is the FINAL quota, never an additive delta. The config name is immutable.
 *
 * Hard rules inherited from the purchase/renewal flows:
 *  - Keyboard values are never trusted: every tap is re-validated against
 *    the FRESH catalog (acceptVolume/acceptDuration/acceptDevice).
 *  - Ownership, free-test exclusion, panel-deleted exclusion, "one active
 *    repurchase at a time", the repurchase kill switch and Sales Stop
 *    are re-checked at START, at each STEP, at SUMMARY render and at CONFIRM.
 *    Repurchase applies to EVERY paid service (active or expired/finished).
 *  - Pricing is the NORMAL purchase pricing (calculatePrice) over the finals.
 *  - Confirmation is idempotent (token → checkout): a replay delivers the
 *    same repurchase order, never a second one.
 *  - Provisioning NEVER creates a panel user (no POST /api/user, no DELETE);
 *    a missing panel user fails closed.
 */
import type { Session } from '../db/states.ts';
import type { UpdateContext } from '../types.ts';
import type { Catalog, StepKind } from '../catalog/catalog.ts';
import {
  acceptDevice,
  acceptDuration,
  acceptVolume,
  enabledDeviceCounts,
  enabledDurationDays,
  enabledVolumeGb,
  loadCatalog,
} from '../catalog/catalog.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { calculatePrice } from '../catalog/pricing.ts';
import { checkoutRepurchaseOrder } from '../orders/checkout.ts';
import { newOrderId } from '../lib/security.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { setSession, clearSession } from '../db/states.ts';
import {
  findActiveRenewalForService,
  findActiveRepurchaseForService,
  getOwnedService,
  type OrderRow,
} from '../db/orders.ts';
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
import {
  loadRepurchaseViewConfig,
  serviceSnapshotData,
  expiryDisplay,
  showMyServices,
} from './services.ts';
import {
  repurchaseModeKeyboard,
  volumeKeyboard,
  durationKeyboard,
  deviceKeyboard,
  confirmKeyboard,
  backToMenuKeyboard,
  walletPayKeyboard,
  mainMenuKeyboard,
} from '../telegram/menu.ts';
import { payableWalletBalance } from './wallet.ts';
import { payOrderWithWallet, refundOrderWalletPayment, setPaidLedgerOrder } from '../db/wallet.ts';
import { planWalletPayment, type WalletPlan } from '../orders/checkout.ts';

import { sendPaymentInstructions } from './payment.ts';
import { reduce } from '../state/machine.ts';

export type RepurchaseMode = 'same' | 'custom';

export interface PrevSpecs {
  name: string;
  volumeGb: number;
  durationDays: number;
  deviceCount: number;
}

/** Canonical specs from the ORIGINAL completed purchase snapshot (never UI state). */
export function prevSpecsOf(service: OrderRow): PrevSpecs | null {
  const snapshot = serviceSnapshotData(service);
  if (
    snapshot.freeTest ||
    snapshot.name === null ||
    snapshot.volumeGb === null ||
    snapshot.durationDays === null ||
    snapshot.deviceCount === null
  ) {
    return null;
  }
  return {
    name: snapshot.name,
    volumeGb: snapshot.volumeGb,
    durationDays: snapshot.durationDays,
    deviceCount: snapshot.deviceCount,
  };
}

export function prevSpecsLine(specs: PrevSpecs): string {
  return `${specs.volumeGb}GB / ${specs.durationDays}d / ${specs.deviceCount}`;
}

/** Reusable guard: owned paid service + enabled + none active. */
async function repurchasableService(
  ctx: UpdateContext,
  serviceOrderId: string,
): Promise<{ ok: true; service: OrderRow; prev: PrevSpecs } | { ok: false; toast: string; clearSession?: boolean }> {
  // A repurchase RECONFIGURES a paid service, so the commercial stop covers
  // it too — checked first, long before any wallet debit (confirmRepurchase
  // claims credit only after this guard) or checkout (backstop below).
  if (await isSalesStopped(ctx.db)) {
    return { ok: false, toast: ctx.ui.t.salesStoppedNotice };
  }
  const repurchase = await loadRepurchaseViewConfig(ctx.db);
  if (!repurchase.enabled) {
    return { ok: false, toast: ctx.ui.t.repDisabledNotice };
  }
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    return { ok: false, toast: ctx.ui.t.serviceNotFound, clearSession: true };
  }
  // A free test is never repurchasable — enforced from the claims table
  // (DB-authoritative), so a forged/hand-edited selections blob can't change
  // the class. The repurchase buttons are already hidden in the detail.
  if (await isFreeTestOrder(ctx.db, service.id)) {
    return { ok: false, toast: ctx.ui.t.repNotForFreeTest };
  }
  const prev = prevSpecsOf(service);
  if (prev === null) {
    return { ok: false, toast: ctx.ui.t.serviceNotFound, clearSession: true };
  }
  const activeRepurchase = await findActiveRepurchaseForService(ctx.db, service.id);
  if (activeRepurchase !== null) {
    return { ok: false, toast: ctx.ui.t.repInProgressNotice(activeRepurchase.id.slice(0, 10)) };
  }
  // Cross-guard with the legacy ladder: one lifecycle operation at a time.
  const activeRenewal = await findActiveRenewalForService(ctx.db, service.id);
  if (activeRenewal !== null) {
    return { ok: false, toast: ctx.ui.t.repInProgressNotice(activeRenewal.id.slice(0, 10)) };
  }
  // No expiry/finished requirement: repurchase is the replacement for renewal
  // on EVERY paid service (active, expiring, expired or finished). Fresh
  // expiry/duration always starts at repurchase time, so remaining time on an
  // active service is forfeited by design — stated in the confirm summary.
  return { ok: true, service, prev };
}

export async function sendRepurchaseModePicker(
  ctx: UpdateContext,
  service: OrderRow,
  prev: PrevSpecs,
): Promise<void> {
  await ctx.api.sendMessage(
    ctx.chatId,
    `${ctx.ui.t.repModeIntro(prev.name, prevSpecsLine(prev))}`,
    repurchaseModeKeyboard(ctx.ui),
  );
}

function repurchaseStepView(
  ctx: UpdateContext,
  state: string,
  catalog: Catalog,
): { text: string; keyboard: Parameters<UpdateContext['api']['sendMessage']>[2] } | null {
  const ui = ctx.ui;
  if (state === 'WAITING_REPURCHASE_VOLUME') {
    return {
      text: ui.t.volumePrompt(catalog.volume.minGb, catalog.volume.maxGb),
      keyboard: volumeKeyboard(ui, enabledVolumeGb(catalog), catalog.volume.allowCustom),
    };
  }
  if (state === 'WAITING_REPURCHASE_DURATION') {
    return {
      text: ui.t.durationPrompt(catalog.duration.minDays, catalog.duration.maxDays, catalog.duration.allowCustom),
      keyboard: durationKeyboard(ui, enabledDurationDays(catalog), catalog.duration.allowCustom),
    };
  }
  if (state === 'WAITING_REPURCHASE_DEVICE') {
    return {
      text: ui.t.devicePrompt(catalog.device.minCount, catalog.device.maxCount, catalog.device.allowCustom),
      keyboard: deviceKeyboard(ui, enabledDeviceCounts(catalog), catalog.device.allowCustom),
    };
  }
  return null;
}

/** `svc:rep` — IDLE-only entry into the repurchase flow. */
export async function startRepurchase(
  ctx: UpdateContext,
  session: Session,
  serviceOrderId: string,
  callbackQueryId: string,
): Promise<void> {
  if (session.state !== 'IDLE') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.serviceBusyFirst, true);
    return;
  }
  const guard = await repurchasableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    return;
  }
  const loaded = await loadCatalog(ctx.db);
  if (!loaded.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.catalogUnavailable, true);
    return;
  }
  void loaded;
  const next = reduce(session.state, 'repurchase_start');
  if (next !== 'WAITING_REPURCHASE_MODE') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, { repurchases_order_id: serviceOrderId });
  await sendRepurchaseModePicker(ctx, guard.service, guard.prev);
}

const REPURCHASE_STEP_STATE: Record<'volume' | 'duration' | 'device', string> = {
  volume: 'WAITING_REPURCHASE_VOLUME',
  duration: 'WAITING_REPURCHASE_DURATION',
  device: 'WAITING_REPURCHASE_DEVICE',
};

/** Mode pick while WAITING_REPURCHASE_MODE. */
export async function applyRepurchaseMode(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  mode: RepurchaseMode,
  callbackQueryId: string,
): Promise<void> {
  const serviceOrderId = session.data['repurchases_order_id'];
  if (
    session.state !== 'WAITING_REPURCHASE_MODE' ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  const guard = await repurchasableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  if (mode === 'same') {
    // Mode A: finals ARE the canonical previous specs — price with the
    // normal purchase calculator over the original values.
    const computed = calculatePrice(catalog.pricing, {
      volumeGb: guard.prev.volumeGb,
      durationDays: guard.prev.durationDays,
      deviceCount: guard.prev.deviceCount,
    });
    if (!computed.ok) {
      await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.catalogUnavailable, true);
      return;
    }
    void computed;
    const next = reduce(session.state, 'repurchase_same');
    if (next !== 'WAITING_REPURCHASE_CONFIRMATION') return;
    const data: Session['data'] = {
      ...session.data,
      repurchase_mode: 'same',
      volume_gb: guard.prev.volumeGb,
      duration_days: guard.prev.durationDays,
      device_count: guard.prev.deviceCount,
    };
    if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await setSession(ctx.db, ctx.customerId, next, data);
    await sendRepurchaseSummary(ctx, { state: next, data }, catalog, guard.service);
    return;
  }
  const next = reduce(session.state, 'repurchase_custom');
  if (next !== 'WAITING_REPURCHASE_VOLUME') return;
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await setSession(ctx.db, ctx.customerId, next, { ...session.data, repurchase_mode: 'custom' });
  const view = repurchaseStepView(ctx, next, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

/**
 * One validated customize choice (buttons and typed custom input share this;
 * callers answer callbacks / parse text beforehand, purchase.ts precedent).
 */
export async function applyRepurchaseStepChoice(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  kind: 'volume' | 'duration' | 'device',
  value: number,
): Promise<void> {
  const ui = ctx.ui;
  const serviceOrderId = session.data['repurchases_order_id'];
  if (
    session.state !== REPURCHASE_STEP_STATE[kind] ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.sendMessage(ctx.chatId, ui.t.staleChoice, backToMenuKeyboard(ui));
    return;
  }
  const check =
    kind === 'volume'
      ? acceptVolume(catalog, value)
      : kind === 'duration'
        ? acceptDuration(catalog, value)
        : acceptDevice(catalog, value);
  if (!check.ok) {
    if (check.reason === 'range') {
      const text =
        kind === 'volume'
          ? ui.t.rejectedVolumeRange(value, catalog.volume.minGb, catalog.volume.maxGb)
          : kind === 'duration'
            ? ui.t.rejectedDurationRange(catalog.duration.minDays, catalog.duration.maxDays)
            : ui.t.rejectedDeviceRange(catalog.device.minCount, catalog.device.maxCount);
      await ctx.api.sendMessage(ctx.chatId, text, backToMenuKeyboard(ui));
    } else {
      await ctx.api.sendMessage(ctx.chatId, ui.t.rejectedPresetDisabled, backToMenuKeyboard(ui));
    }
    return;
  }
  const guard = await repurchasableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.sendMessage(ctx.chatId, guard.toast, backToMenuKeyboard(ui));
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const event =
    kind === 'volume'
      ? 'repurchase_volume_chosen'
      : kind === 'duration'
        ? 'repurchase_duration_chosen'
        : 'repurchase_device_chosen';
  const next = reduce(session.state, event);
  if (next === session.state) return; // stale/illegal: never advance
  const data: Session['data'] = { ...session.data };
  if (kind === 'volume') data['volume_gb'] = value;
  else if (kind === 'duration') data['duration_days'] = value;
  else data['device_count'] = value;
  if (next === 'WAITING_REPURCHASE_CONFIRMATION') {
    if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
    await setSession(ctx.db, ctx.customerId, next, data);
    await sendRepurchaseSummary(ctx, { state: next, data }, catalog, guard.service);
    return;
  }
  await setSession(ctx.db, ctx.customerId, next, data);
  const view = repurchaseStepView(ctx, next, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

export interface RepurchaseDraft {
  mode: RepurchaseMode;
  volumeGb: number;
  durationDays: number;
  deviceCount: number;
}

/** Finals strictly from server-side session data (never callback values). */
export function extractRepurchaseDraft(session: Session): RepurchaseDraft | null {
  const { repurchase_mode: mode, volume_gb: gb, duration_days: days, device_count: devices } = session.data;
  if (
    (mode !== 'same' && mode !== 'custom') ||
    typeof gb !== 'number' ||
    typeof days !== 'number' ||
    typeof devices !== 'number' ||
    !Number.isSafeInteger(gb) ||
    !Number.isSafeInteger(days) ||
    !Number.isSafeInteger(devices)
  ) {
    return null;
  }
  return { mode, volumeGb: gb, durationDays: days, deviceCount: devices };
}

/** Renders the repurchase summary strictly from server-side data. */
export async function sendRepurchaseSummary(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  service: OrderRow,
): Promise<void> {
  const token = session.data['order_token'];
  const draft = extractRepurchaseDraft(session);
  if (typeof token !== 'string' || !draft) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.missingDraftData, backToMenuKeyboard(ctx.ui));
    return;
  }
  const computed = calculatePrice(catalog.pricing, draft);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const b = computed.breakdown;
  const name = serviceSnapshotData(service).name ?? ctx.ui.t.accountNone;
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  const lines = [
    ctx.ui.t.repSummaryHeader,
    ctx.ui.t.repSummaryService(name),
    ctx.ui.t.summaryVolume(b.volume_gb),
    ctx.ui.t.summaryDuration(b.duration_days, b.months),
    ctx.ui.t.summaryDevices(b.device_count),
    ctx.ui.t.summaryPrice(ctx.ui.f.price(b.total, b.currency)),
    ctx.ui.t.repSummaryReuse,
    ctx.ui.t.repSummaryFreshCycle,
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

/** `ord:confirm` while WAITING_REPURCHASE_CONFIRMATION — the only durable exit. */
export async function confirmRepurchase(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
  wallet: WalletPlan | null = null,
): Promise<void> {
  // Commercial stop first: a stopped state can never consume wallet credit
  // or create an order (unbypassable backstop also lives in checkout).
  if (await isSalesStopped(ctx.db)) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  const token = session.data['order_token'];
  const draft = extractRepurchaseDraft(session);
  const serviceOrderId = session.data['repurchases_order_id'];
  if (
    session.state !== 'WAITING_REPURCHASE_CONFIRMATION' ||
    typeof token !== 'string' ||
    !draft ||
    typeof serviceOrderId !== 'string' ||
    !isValidOrderId(serviceOrderId)
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice);
    return;
  }
  const guard = await repurchasableService(ctx, serviceOrderId);
  if (!guard.ok) {
    await ctx.api.answerCallbackQuery(callbackQueryId, guard.toast, true);
    if (guard.clearSession) await clearSession(ctx.db, ctx.customerId);
    return;
  }
  const computed = calculatePrice(catalog.pricing, draft);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  const snapshotName = serviceSnapshotData(guard.service).name ?? ctx.ui.t.accountNone;

  // Wallet-full: plan → claim the debit against the DRAFT TOKEN (the only id
  // that exists before the row; exactly-once by NOT EXISTS in the same
  // UPDATE) → durable order is BORN 'approved'. Same discipline as purchase.
  if (wallet && wallet.mode === 'full') {
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
  } else if (wallet && wallet.mode === 'partial') {
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

  const result = await checkoutRepurchaseOrder(
    ctx.db,
    {
      customerId: ctx.customerId,
      orderToken: token,
      catalog,
      breakdown: computed.breakdown,
      serviceOrderId: guard.service.id,
      mode: draft.mode,
    },
    snapshotName,
    wallet ?? undefined,
  );
  if (!result.ok) {
    console.error(`repurchase_checkout_failed error=${result.error.slice(0, 60)}`);
    // Wallet money was already claimed on the draft token. Race with an
    // earlier checkout? Then THAT row owns the paid money — refund ONLY
    // when no order exists for this token at all (purchase.ts discipline;
    // refundOrderWalletPayment is claim-row exactly-once).
    if (wallet) {
      if (wallet.mode === 'full') {
        const orphan = await findOrderByIdempotencyKeySoft(ctx.db, token);
        if (orphan === null) {
          await refundOrderWalletPayment(ctx.db, {
            customerId: ctx.customerId,
            orderId: token,
            actor: 'customer',
          }).catch(() => undefined);
        }
      } else {
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
      ctx.ui.t.walletPaidRepurchase(result.order.id, ctx.ui.f.price(wallet.creditIrt, 'IRT')),
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
  const next = reduce(session.state, 'repurchase_confirmed');
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
    await ctx.api.sendMessage(
      ctx.chatId,
      ctx.ui.t.walletPartialRepurchase(
        result.order.id,
        ctx.ui.f.price(wallet.creditIrt, 'IRT'),
        ctx.ui.f.price(result.order.amount, result.order.currency),
      ),
      backToMenuKeyboard(ctx.ui),
    );
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    ctx.ui.t.repConfirmed(result.order.id),
    backToMenuKeyboard(ctx.ui),
  );
  await sendPaymentInstructions(ctx, result.order);
}

/** `wlt:full|wlt:part` while WAITING_REPURCHASE_CONFIRMATION. */
export async function confirmRepurchaseWithWallet(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  mode: 'full' | 'partial',
  callbackQueryId: string,
): Promise<void> {
  // Wallet repurchase creation obeys the same commercial stop — blocked here
  // so no debit plan is ever computed against a live balance.
  if (await isSalesStopped(ctx.db)) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  if (balance === null) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const draft = extractRepurchaseDraft(session);
  if (!draft || session.state !== 'WAITING_REPURCHASE_CONFIRMATION') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  const computed = calculatePrice(catalog.pricing, draft);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const plan = planWalletPayment(computed.breakdown.total, balance, mode);
  if (!plan) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.walletBalanceLow, backToMenuKeyboard(ctx.ui));
    return;
  }
  await confirmRepurchase(ctx, session, catalog, callbackQueryId, plan);
}

/** `step:back` inside the repurchase flow (… → device → duration → volume → mode → IDLE). */
export async function repurchaseGoBack(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
): Promise<'handled' | 'not-repurchase'> {
  if (
    session.state !== 'WAITING_REPURCHASE_MODE' &&
    session.state !== 'WAITING_REPURCHASE_VOLUME' &&
    session.state !== 'WAITING_REPURCHASE_DURATION' &&
    session.state !== 'WAITING_REPURCHASE_DEVICE' &&
    session.state !== 'WAITING_REPURCHASE_CONFIRMATION'
  ) {
    return 'not-repurchase';
  }
  // Back from the mode picker leaves the flow entirely → services list.
  if (session.state === 'WAITING_REPURCHASE_MODE') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await clearSession(ctx.db, ctx.customerId);
    await showMyServices(ctx);
    return 'handled';
  }
  const serviceOrderId = session.data['repurchases_order_id'];
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
  const prev = prevSpecsOf(service);
  const next = reduce(session.state, 'step_back');
  await setSession(ctx.db, ctx.customerId, next, { ...session.data });
  if (next === 'WAITING_REPURCHASE_MODE') {
    if (prev) await sendRepurchaseModePicker(ctx, service, prev);
    else await showMyServices(ctx);
    return 'handled';
  }
  if (next === 'WAITING_REPURCHASE_CONFIRMATION') {
    await sendRepurchaseSummary(ctx, { state: next, data: { ...session.data } }, catalog, service);
    return 'handled';
  }
  const view = repurchaseStepView(ctx, next, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
  return 'handled';
}

/**
 * Re-entering the flow while a repurchase step is live (menu buy tap or
 * stray text): redraw the CURRENT step, state preserved.
 */
export async function resumeRepurchase(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
): Promise<void> {
  const serviceOrderId = session.data['repurchases_order_id'];
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
  if (session.state === 'WAITING_REPURCHASE_MODE') {
    const prev = prevSpecsOf(service);
    if (prev) await sendRepurchaseModePicker(ctx, service, prev);
    else await showMyServices(ctx);
    return;
  }
  if (session.state === 'WAITING_REPURCHASE_CONFIRMATION') {
    await sendRepurchaseSummary(ctx, session, catalog, service);
    return;
  }
  const view = repurchaseStepView(ctx, session.state, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

export const REPURCHASE_TEXT_STATE_KIND: Record<string, 'volume' | 'duration' | 'device'> = {
  WAITING_REPURCHASE_VOLUME: 'volume',
  WAITING_REPURCHASE_DURATION: 'duration',
  WAITING_REPURCHASE_DEVICE: 'device',
};

/**
 * Customer self-cancel of their OWN active repurchase (`svc:cancel:` carries
 * the SERVICE id, never the repurchase id). Ownership is enforced by
 * getOwnedService; the lock holder is re-resolved server-side, so a forged
 * tap can only ever address the caller's own service. Uses the SAME shared
 * idempotent core as the admin path (guarded D1 claim, exactly-once wallet
 * refund, conditional session restore, zero PasarGuard calls).
 */
export async function cancelOwnRepurchase(
  ctx: UpdateContext,
  serviceOrderId: string,
  callbackQueryId: string,
): Promise<void> {
  const { performRepurchaseCancel } = await import('../admin.ts');
  const { isRepurchaseProvisioningStarted } = await import('../db/orders.ts');
  const service = await getOwnedService(ctx.db, ctx.customerId, serviceOrderId);
  if (!service) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.serviceNotFound, true);
    return;
  }
  const active = await findActiveRepurchaseForService(ctx.db, service.id);
  if (!active || active.customer_id !== ctx.customerId) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.repCancelStale, true);
    return;
  }
  if (isRepurchaseProvisioningStarted(active)) {
    await ctx.api.answerCallbackQuery(
      callbackQueryId,
      ctx.ui.t.repCancelBlockedProvisioning,
      true,
    );
    return;
  }
  const result = await performRepurchaseCancel({
    db: ctx.db,
    api: ctx.api,
    actorTag: `customer:${String(ctx.actor.id)}`,
    orderId: active.id,
    reason: 'customer cancelled repurchase',
  });
  if (!result.ok) {
    const toast =
      result.error === 'provisioning_started'
        ? ctx.ui.t.repCancelBlockedProvisioning
        : ctx.ui.t.repCancelStale;
    await ctx.api.answerCallbackQuery(callbackQueryId, toast, true);
    return;
  }
  await ctx.api.answerCallbackQuery(
    callbackQueryId,
    result.alreadyCancelled ? ctx.ui.t.repCancelStale : ctx.ui.t.repCancelledDone(active.id),
  );
}
