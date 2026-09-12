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
} from '../catalog/catalog.ts';
import { calculatePrice } from '../catalog/pricing.ts';
import { newOrderId } from '../lib/security.ts';
import { checkoutOrder } from '../orders/checkout.ts';
import { CB, deviceKeyboard, durationKeyboard, volumeKeyboard, confirmKeyboard, backToMenuKeyboard } from '../telegram/menu.ts';
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
        text: fa.durationPrompt(catalog.duration.minDays, catalog.duration.maxDays),
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
    await ctx.api.sendMessage(ctx.chatId, fa.missingDraftData, backToMenuKeyboard());
    return;
  }
  const computed = calculatePrice(catalog.pricing, price);
  if (!computed.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  const b = computed.breakdown;
  const lines = [
    fa.summaryHeader,
    fa.summaryName(String(session.data['config_name'])),
    fa.summaryVolume(b.volume_gb),
    fa.summaryDuration(b.duration_days, b.months),
    fa.summaryDevices(b.device_count),
    fa.summaryPrice(formatPrice(b.total, b.currency)),
    fa.summaryId(String(session.data['order_token'])),
    fa.summaryHint,
  ];
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), confirmKeyboard());
}

/** `ord:confirm` — the ONLY exit that creates a durable order. */
export async function confirmPurchase(
  ctx: UpdateContext,
  session: Session,
  catalog: Catalog,
  callbackQueryId: string,
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

  const result = await checkoutOrder(ctx.db, {
    customerId: ctx.customerId,
    orderToken: token,
    configName: String(session.data['config_name']),
    catalog,
    breakdown: computed.breakdown,
  });
  if (!result.ok) {
    console.error(`checkout_failed ${result.error}`);
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
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
  await ctx.api.sendMessage(ctx.chatId, fa.orderCreated(result.order.id), backToMenuKeyboard());
  await sendPaymentInstructions(ctx, result.order);
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
    await ctx.api.sendMessage(ctx.chatId, fa.buyWaitingConfigName, backToMenuKeyboard());
    return;
  }
  const view = stepView(next, catalog);
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
