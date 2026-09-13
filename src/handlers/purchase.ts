import type { ConversationState, TelegramInlineKeyboardMarkup, UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import { setSession } from '../db/states.ts';
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
import { calculatePrice } from '../catalog/pricing.ts';
import { payableWalletBalance } from './wallet.ts';
import { payOrderWithWallet, refundOrderWalletPayment, setPaidLedgerOrder } from '../db/wallet.ts';
import { findOrderByIdempotencyKey } from '../db/orders.ts';

async function findOrderByIdempotencyKeySoft(db: D1Database, token: string) {
  try {
    return await findOrderByIdempotencyKey(db, token);
  } catch {
    return undefined;
  }
}
import { payReferrerIfDue } from '../lib/referralPayout.ts';
import { provisionOrder } from '../provision/provision.ts';
import { newOrderId } from '../lib/security.ts';
import { checkoutOrder, planWalletPayment, walletCreditFromSnapshot, type WalletPlan } from '../orders/checkout.ts';
import { CB, deviceKeyboard, durationKeyboard, volumeKeyboard, confirmKeyboard, backToMenuKeyboard, walletPayKeyboard, configNameKeyboard, mainMenuKeyboard } from '../telegram/menu.ts';
import { fa, formatPrice } from '../telegram/texts.ts';
import { sendPaymentInstructions } from './payment.ts';
import { reduce } from '../state/machine.ts';

/**
 * Purchase flow steps (volume → duration → devices → summary → confirm).
 * Keyboard values are re-validated against the FRESH catalog on every update:
 * keyboards can be stale, buttons can be forged, config can change mid-flow.
 */

export const STEP_EXPECTED_STATE: Record<StepKind, ConversationState> = {
  volume: 'WAITING_VOLUME',
  duration: 'WAITING_DURATION',
  device: 'WAITING_DEVICE_LIMIT',
};

export interface StepView {
  text: string;
  keyboard: TelegramInlineKeyboardMarkup;
}

export function stepView(state: ConversationState, catalog: Catalog): StepView | null {
  switch (state) {
    case 'WAITING_VOLUME':
      return {
        text: fa.volumePrompt(catalog.volume.minGb, catalog.volume.maxGb),
        keyboard: volumeKeyboard(enabledVolumeGb(catalog), catalog.volume.allowCustom),
      };
    case 'WAITING_DURATION':
      return {
        text: fa.durationPrompt(
          catalog.duration.minDays,
          catalog.duration.maxDays,
          catalog.duration.allowCustom,
        ),
        keyboard: durationKeyboard(enabledDurationDays(catalog), catalog.duration.allowCustom),
      };
    case 'WAITING_DEVICE_LIMIT':
      return {
        text: fa.devicePrompt(catalog.device.minCount, catalog.device.maxCount),
        keyboard: deviceKeyboard(enabledDeviceCounts(catalog), catalog.device.allowCustom),
      };
    default:
      return null;
  }
}

function rejectionMessage(catalog: Catalog, kind: StepKind, reason: string): string {
  if (reason === 'range') {
    const range =
      kind === 'volume'
        ? [catalog.volume.minGb, catalog.volume.maxGb]
        : kind === 'duration'
          ? [catalog.duration.minDays, catalog.duration.maxDays]
          : [catalog.device.minCount, catalog.device.maxCount];
    return fa.rejectedRange(range[0] ?? 0, range[1] ?? 0);
  }
  return fa.rejectedPresetDisabled;
}

/**
 * Applies one validated numeric choice for the CURRENT step, persists the
 * draft, advances via the machine, and renders the next prompt / summary.
 */
export async function applyStepChoice(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  kind: StepKind,
  value: number,
): Promise<void> {
  const result =
    kind === 'volume'
      ? acceptVolume(catalog, value)
      : kind === 'duration'
        ? acceptDuration(catalog, value)
        : acceptDevice(catalog, value);
  if (!result.ok) {
    await ctx.api.sendMessage(ctx.chatId, rejectionMessage(catalog, kind, result.reason));
    return;
  }

  const event =
    kind === 'volume' ? 'volume_chosen'
      : kind === 'duration' ? 'duration_chosen'
        : 'devices_chosen';
  const next = reduce(session.state, event);
  if (next === session.state) return; // stale/illegal: never advance

  const data = { ...session.data };
  if (kind === 'volume') data['volume_gb'] = value;
  else if (kind === 'duration') data['duration_days'] = value;
  else data['device_count'] = value;

  if (next === 'WAITING_ORDER_CONFIRMATION') {
    // The confirmation step mints the durable draft identity exactly once.
    if (typeof data['order_token'] !== 'string') data['order_token'] = newOrderId();
    await setSession(ctx.db, ctx.customerId, next, data);
    await sendSummary(ctx, { state: next, data }, catalog);
    return;
  }

  await setSession(ctx.db, ctx.customerId, next, data);
  const view = stepView(next, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

/** Renders the summary strictly from server-side draft data. */
export async function sendSummary(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
): Promise<void> {
  const price = extractDraft(session);
  if (!price) {
    // Phase 8A: unrecoverable draft → land on the menu and restore the keyboard.
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, mainMenuKeyboard());
    return;
  }
  const computed = calculatePrice(catalog.pricing, price);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  const b = computed.breakdown;
  const balance = await payableWalletBalance(ctx.db, ctx.customerId);
  const lines = [
    fa.summaryHeader,
    fa.summaryName(String(session.data['config_name'])),
    fa.summaryVolume(b.volume_gb),
    fa.summaryDuration(b.duration_days, b.months),
    fa.summaryDevices(b.device_count),
    fa.summaryPrice(formatPrice(b.total, b.currency)),
    fa.summaryId(String(session.data['order_token'])),
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

/** `ord:confirm` — the ONLY exit that creates a durable order. */
export async function confirmPurchase(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
  wallet: WalletPlan | null = null,
): Promise<void> {
  const token = session.data['order_token'];
  const draft = extractDraft(session);
  if (
    session.state !== 'WAITING_ORDER_CONFIRMATION' ||
    typeof token !== 'string' ||
    !draft
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.staleChoice);
    return;
  }
  const computed = calculatePrice(catalog.pricing, draft);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }

  // Phase 7 wallet-full: plan → claim the debit against the DRAFT TOKEN
  // (the only id that exists before the row; exactly-once by NOT EXISTS in
  // the same UPDATE) → durable order is BORN 'approved' with amount=0 → one
  // ledger re-point to the real order id for refund lookup. A lost debit
  // (balance drained since the summary) degrades to the plain flow.
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
        paid.reason === 'insufficient' ? fa.walletBalanceLow : fa.catalogUnavailable,
        true,
      );
      await resendWalletGuidance(ctx, session, catalog, paid.reason);
      return;
    }
    const result = await checkoutOrder(
      ctx.db,
      {
        customerId: ctx.customerId,
        orderToken: token,
        configName: String(session.data['config_name']),
        catalog,
        breakdown: computed.breakdown,
      },
      wallet,
    );
    if (!result.ok) {
      console.error(`checkout_failed ${result.error}`);
      // Race with an earlier checkout? Then THAT row owns the paid money.
      // Refund ONLY on a confirmed miss (null); an errored lookup stays
      // undefined — never refund on "unknown".
      const orphan = await findOrderByIdempotencyKeySoft(ctx.db, token);
      if (orphan === null) {
        await refundOrderWalletPayment(ctx.db, {
          customerId: ctx.customerId,
          orderId: token,
          actor: 'customer',
        }).catch(() => undefined);
      }
      await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      await ctx.api.answerCallbackQuery(callbackQueryId);
      return;
    }
    if (result.created) {
      await setPaidLedgerOrder(ctx.db, token, result.order.id);
    }
    await setSession(ctx.db, ctx.customerId, 'IDLE', {});
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.walletPayConfirmToast);
    await ctx.api.sendMessage(
      ctx.chatId,
      fa.walletPaidOrderCreated(result.order.id, formatPrice(wallet.creditIrt, 'IRT')),
      mainMenuKeyboard(),
    );
    await afterOrderApproved(result.order, ctx);
    return;
  }

  // Partial credit: debit BEFORE checkout (claim id = token), create as
  // pending_payment with amount = remainder; the existing receipt pipeline
  // continues untouched. Rejecting the order refunds via the re-pointed row.
  if (wallet && wallet.mode === 'partial') {
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
      await resendWalletGuidance(ctx, session, catalog, paid.reason);
      return;
    }
  }

  const result = await checkoutOrder(
    ctx.db,
    {
      customerId: ctx.customerId,
      orderToken: token,
      configName: String(session.data['config_name']),
      catalog,
      breakdown: computed.breakdown,
    },
    wallet ?? undefined,
  );
  if (!result.ok) {
    console.error(`checkout_failed ${result.error}`);
    if (wallet && wallet.mode === 'partial') {
      await refundOrderWalletPayment(ctx.db, {
        customerId: ctx.customerId,
        orderId: token,
        actor: 'customer',
      }).catch(() => undefined);
    }
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (result.created && wallet && wallet.mode === 'partial') {
    await setPaidLedgerOrder(ctx.db, token, result.order.id);
  }

  const data = { ...session.data, order_id: result.order.id };
  await setSession(
    ctx.db,
    ctx.customerId,
    reduce(session.state, 'order_confirmed'),
    data,
  );
  await ctx.api.answerCallbackQuery(callbackQueryId, fa.orderConfirmToast, !result.created);
  if (!result.created) {
    // Replay of an old confirm button on an order that may have moved on.
    await ctx.api.sendMessage(ctx.chatId, fa.alreadyConfirmed, backToMenuKeyboard());
    await resendPaymentGuidance(ctx, result.order);
    return;
  }
  if (wallet && wallet.mode === 'partial') {
    await ctx.api.sendMessage(
      ctx.chatId,
      fa.walletPartialCreated(
        result.order.id,
        formatPrice(wallet.creditIrt, 'IRT'),
        formatPrice(result.order.amount, result.order.currency),
      ),
      mainMenuKeyboard(),
    );
  } else {
    await ctx.api.sendMessage(ctx.chatId, fa.orderCreated(result.order.id), mainMenuKeyboard());
  }
  await sendPaymentInstructions(ctx, result.order);
}

/**
 * The wallet tap on a summary: plans the payment from the CURRENT balance,
 * mints nothing new (order_token is already the draft identity), then runs
 * the shared confirm path. A vanished/insufficient balance degrades the tap
 * to a notice + a plain re-render of the summary.
 */
export async function confirmPurchaseWithWallet(
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
  const draft = extractDraft(session);
  if (!draft || session.state !== 'WAITING_ORDER_CONFIRMATION') {
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, mainMenuKeyboard());
    return;
  }
  const computed = calculatePrice(catalog.pricing, draft);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  const plan = planWalletPayment(computed.breakdown.total, balance, mode);
  if (!plan) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletBalanceLow, backToMenuKeyboard());
    return;
  }
  await confirmPurchase(ctx, session, catalog, callbackQueryId, plan);
}

async function resendWalletGuidance(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  _reason: string,
): Promise<void> {
  await sendSummary(ctx, session, catalog);
}

/** Post-approval side effects shared with the admin-review path. */
export async function afterOrderApproved(order: import('../db/orders.ts').OrderRow, ctx: UpdateContext): Promise<void> {
  const provisioning = provisionOrder(
    { env: ctx.env, db: ctx.db, api: ctx.api },
    { orderId: order.id },
  ).then((outcome) => {
    if (!outcome.ok && 'skip' in outcome) {
      console.log(`provision_skipped orderId=${order.id.slice(0, 32)} reason=${outcome.skip}`);
    }
    return outcome;
  });
  const payout = payReferrerIfDue(ctx.db, ctx.api, order, 'customer');
  if (ctx.waitUntil) {
    ctx.waitUntil(provisioning);
    ctx.waitUntil(payout);
  } else {
    await Promise.all([provisioning, payout]);
  }
}

/** Replays after confirmation: payment info (still payable) or live status. */
async function resendPaymentGuidance(ctx: UpdateContext, order: import('../db/orders.ts').OrderRow): Promise<void> {
  if (order.state === 'pending_payment' || order.state === 'awaiting_review') {
    await sendPaymentInstructions(ctx, order);
  } else {
    await ctx.api.sendMessage(ctx.chatId, fa.paymentWaitNotice, backToMenuKeyboard());
  }
}

/** `step:back` — the edit ladder. Draft data is preserved on the way back. */
export async function goBack(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
): Promise<void> {
  const next = reduce(session.state, 'step_back');
  await ctx.api.answerCallbackQuery(callbackQueryId);

  // WAITING_PAYMENT_RECEIPT: order is durable and frozen — only re-show notice.
  if (session.state === 'WAITING_PAYMENT_RECEIPT') {
    await ctx.api.sendMessage(ctx.chatId, fa.paymentWaitNotice, backToMenuKeyboard());
    return;
  }
  if (next === session.state) {
    await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
    return;
  }

  // Returning to the confirmation step reuses the same token (same order).
  await setSession(ctx.db, ctx.customerId, next, { ...session.data });

  if (next === 'WAITING_ORDER_CONFIRMATION') {
    await sendSummary(ctx, { state: next, data: session.data }, catalog);
    return;
  }
  if (next === 'WAITING_CONFIG_NAME') {
    await ctx.api.sendMessage(ctx.chatId, fa.buyWaitingConfigName, configNameKeyboard());
    return;
  }
  const view = stepView(next, catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

/**
 * One accepted config name — IDENTICAL path for typed input and the
 * 🎲 auto-pick tap (single source of truth). `name` must already be the
 * result of `validateConfigName` (the auto picker generates names that pass
 * by construction; nothing here trusts a keyboard).
 */
export async function continueWithConfigName(
  ctx: UpdateContext,
  session: Session,
  name: string,
): Promise<void> {
  const next = reduce(session.state, 'name_accepted'); // → WAITING_VOLUME
  await setSession(ctx.db, ctx.customerId, next, { ...session.data, config_name: name });

  const loaded = await loadCatalog(ctx.db);
  if (!loaded.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  await ctx.api.sendMessage(ctx.chatId, fa.configNameSaved(name), backToMenuKeyboard());
  const view = stepView(next, loaded.catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

function extractDraft(session: Session) {
  const { volume_gb: gb, duration_days: days, device_count: devices, config_name: name } = session.data;
  if (
    typeof name !== 'string' ||
    typeof gb !== 'number' ||
    typeof days !== 'number' ||
    typeof devices !== 'number'
  ) {
    return null;
  }
  return { volumeGb: gb, durationDays: days, deviceCount: devices };
}
