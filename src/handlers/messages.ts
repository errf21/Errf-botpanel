import type { UpdateContext } from '../types.ts';
import {
  parsePositiveInt,
  sanitizeConfigName,
  sanitizeRejectionReason,
  type ReceiptMedia,
} from '../lib/validate.ts';
import { backToMenuKeyboard, mainMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getSession, setSession } from '../db/states.ts';
import {
  clearPendingAdminAction,
  getPendingAdminAction,
} from '../db/admin_actions.ts';
import { performAdminReview } from '../admin.ts';
import { acceptsTextInput, reduce } from '../state/machine.ts';
import { loadCatalog, type StepKind } from '../catalog/catalog.ts';
import { submitReceipt } from './payment.ts';
import { resumeRenewal } from './renewal.ts';
import {
  STEP_EXPECTED_STATE,
  applyStepChoice,
  sendSummary,
  stepView,
} from './purchase.ts';

/**
 * Plain-text messages, routed through the state machine.
 * Accepted where `acceptsTextInput(state)`:
 *  - WAITING_CONFIG_NAME   → sanitized free-text name
 *  - WAITING_VOLUME / …    → a custom numeric ("دلخواه") value for that step
 * Phase 4 additions (checked FIRST, they intercept an otherwise-valid flow):
 *  - admin with a pending "reject" action → the text IS the rejection reason
 *  - photo/document while WAITING_PAYMENT_RECEIPT → receipt (dispatch routes
 *    media here via handleMedia).
 * Everything else is politely ignored (state preserved).
 */
export async function handleText(ctx: UpdateContext, text: string): Promise<void> {
  if (ctx.isAdmin) {
    const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
    if (pending) {
      const reason = sanitizeRejectionReason(text);
      if (reason === null) {
        // too long / empty: pending action stays, ask again
        await ctx.api.sendMessage(ctx.chatId, fa.adminRejectPromptMsg);
        return;
      }
      await clearPendingAdminAction(ctx.db, ctx.actor.id);
      const result = await performAdminReview({
        env: ctx.env,
        db: ctx.db,
        api: ctx.api,
        actorId: ctx.actor.id,
        orderId: pending.order_id,
        decision: 'reject',
        reason,
      });
      await ctx.api.sendMessage(
        ctx.chatId,
        result.ok ? fa.adminRejectedToast : fa.adminStaleToast,
      );
      return;
    }
  }

  const session = await getSession(ctx.db, ctx.customerId);

  if (!acceptsTextInput(session.state)) {
    if (session.state === 'WAITING_ORDER_CONFIRMATION') {
      // mid-summary typing: re-show summary without changing anything
      const loaded = await loadCatalog(ctx.db);
      if (loaded.ok) await sendSummary(ctx, session, loaded.catalog);
      else await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      return;
    }
    if (session.state === 'WAITING_PAYMENT_RECEIPT') {
      await ctx.api.sendMessage(ctx.chatId, fa.paymentWaitNotice, backToMenuKeyboard());
      return;
    }
    // Phase 6: renewal ladder steps never accept free text (months only).
    if (
      session.state === 'WAITING_RENEWAL_DURATION' ||
      session.state === 'WAITING_RENEWAL_CONFIRMATION'
    ) {
      const loaded = await loadCatalog(ctx.db);
      if (loaded.ok) await resumeRenewal(ctx, session, loaded.catalog);
      else await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      return;
    }
    await ctx.api.sendMessage(ctx.chatId, fa.idleInputHint, mainMenuKeyboard());
    return;
  }

  // Numeric purchase steps (custom volume/duration/device via text)
  const numericKind = numericStepFor(session.state);
  if (numericKind) {
    const loaded = await loadCatalog(ctx.db);
    if (!loaded.ok) {
      await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      return;
    }
    const value = parsePositiveInt(text);
    if (value === null) {
      await ctx.api.sendMessage(ctx.chatId, fa.rejectedNotWhole, backToMenuKeyboard());
      return;
    }
    await applyStepChoice(ctx, session, loaded.catalog, numericKind, value);
    return;
  }

  // WAITING_CONFIG_NAME
  const name = sanitizeConfigName(text);
  if (!name) {
    await ctx.api.sendMessage(ctx.chatId, fa.configNameInvalid, backToMenuKeyboard());
    return;
  }

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

function numericStepFor(state: string): StepKind | null {
  for (const [kind, expected] of Object.entries(STEP_EXPECTED_STATE) as [StepKind, string][]) {
    if (state === expected) return kind;
  }
  return null;
}

/**
 * Photo/document uploads (dispatched to here when it is not a text message).
 * Only WAITING_PAYMENT_RECEIPT consumes them — as a (replacement) receipt.
 * Everywhere else the media is ignored with a neutral hint, state preserved.
 */
export async function handleMedia(
  ctx: UpdateContext,
  receipt: ReceiptMedia,
): Promise<void> {
  const session = await getSession(ctx.db, ctx.customerId);
  if (session.state === 'WAITING_PAYMENT_RECEIPT') {
    await submitReceipt(ctx, session, receipt);
    return;
  }
  if (session.state === 'IDLE') {
    await ctx.api.sendMessage(ctx.chatId, fa.idleInputHint, mainMenuKeyboard());
    return;
  }
  await ctx.api.sendMessage(ctx.chatId, fa.receiptExpectedMedia, backToMenuKeyboard());
}
