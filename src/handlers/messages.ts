import type { UpdateContext } from '../types.ts';
import {
  parsePositiveInt,
  sanitizeRejectionReason,
  sanitizeSupportBody,
  type ReceiptMedia,
} from '../lib/validate.ts';
import {
  adminRejectPromptKeyboard,
  backToMenuKeyboard,
  composingKeyboard,
  mainMenuKeyboard,
  configNameKeyboard,
  menuCallbackForText,
  STEP_AUTO_TEXT,
  STEP_BACK_TEXT,
  STEP_SKIP_REJECT_TEXT,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { randomConfigName, validateConfigName } from '../lib/configName.ts';
import { getSession } from '../db/states.ts';
import {
  clearPendingAdminAction,
  getPendingAdminAction,
} from '../db/admin_actions.ts';
import { performAdminReview } from '../admin.ts';
import { acceptsTextInput, isBusy } from '../state/machine.ts';
import { loadCatalog, type StepKind } from '../catalog/catalog.ts';
import { submitReceipt } from './payment.ts';
import { resumeRenewal } from './renewal.ts';
import { deliverTicketReply, submitSupportText } from './support.ts';
import { saveAnnounceDraft } from './announcements.ts';
import { completeArmedWalletAction } from './wallet.ts';
import { findLiveTicket } from '../db/support.ts';
import { cancelToMenu } from './commands.ts';
import { runMainMenuAction } from './menuActions.ts';
import {
  STEP_EXPECTED_STATE,
  applyStepChoice,
  continueWithConfigName,
  sendSummary,
} from './purchase.ts';

/**
 * Plain-text messages, routed through the state machine.
 * Phase 8A: Reply Keyboard taps arrive as ordinary text. The exact-match
 * interceptions below cover ONLY labels the keyboard can currently display
 * (main-menu entries while IDLE, back/auto on composing prompts, skip on a
 * live reject arming); every other input flows exactly as before.
 * Accepted where `acceptsTextInput(state)`:
 *  - WAITING_CONFIG_NAME   → sanitized free-text name
 *  - WAITING_VOLUME / …    → a custom numeric ("دلخواه") value for that step
 *  - WAITING_SUPPORT_MESSAGE / WAITING_ANNOUNCE_TEXT → Phase 7 bodies
 * Phase 4 additions (checked after the Phase 8A keyboard interceptions):
 *  - admin with a pending "reject" action → the text IS the rejection reason
 *  - Phase 7: pending support_reply / wallet_grant / wallet_debit likewise
 *  - photo/document while WAITING_PAYMENT_RECEIPT → receipt (dispatch routes
 *    media here via handleMedia).
 * Everything else is politely ignored (state preserved).
 */
export async function handleText(ctx: UpdateContext, text: string): Promise<void> {
  // ———— Phase 8A: keyboard back button — mirrors `act:back_menu` exactly.
  // Clears a live admin arming first, then any busy flow; restores the menu.
  if (text === STEP_BACK_TEXT) {
    await handleBackToMenuText(ctx);
    return;
  }

  const session = await getSession(ctx.db, ctx.customerId);

  // Keyboard auto-pick: meaningful ONLY while the name is being asked for
  // (identical state gate as the `cfg:auto` callback tap).
  if (text === STEP_AUTO_TEXT && session.state === 'WAITING_CONFIG_NAME') {
    await continueWithConfigName(ctx, session, randomConfigName());
    return;
  }

  // Main-menu shortcuts: exact labels, ONLY from IDLE — any busy state keeps
  // its existing safe text handling (validators/steps), never menu actions.
  const shortcut = menuCallbackForText(text);
  if (shortcut !== null && session.state === 'IDLE') {
    await runMainMenuAction(ctx, session, shortcut);
    return;
  }

  if (ctx.isAdmin) {
    const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
    if (pending) {
      if (
        pending.action === 'reject' &&
        pending.order_id !== null &&
        text === STEP_SKIP_REJECT_TEXT
      ) {
        // Keyboard skip = the legacy `adm:skip:` tap (same guard, same effect).
        await clearPendingAdminAction(ctx.db, ctx.actor.id);
        const result = await performAdminReview({
          env: ctx.env,
          db: ctx.db,
          api: ctx.api,
          actorId: ctx.actor.id,
          orderId: pending.order_id,
          decision: 'reject',
          reason: fa.adminRejectDefaultReason,
        });
        await ctx.api.sendMessage(
          ctx.chatId,
          result.ok ? fa.adminRejectedToast : fa.adminStaleToast,
        );
        return;
      }
      if (pending.action === 'support_reply' && pending.target_id) {
        const body = sanitizeSupportBody(text);
        if (body === null) {
          await ctx.api.sendMessage(ctx.chatId, fa.adminTicketPrompt, composingKeyboard());
          return;
        }
        // A consumed reply clears the arming; a stale one also clears — the
        // ticket is gone and the prompt must not silently re-target others.
        await clearPendingAdminAction(ctx.db, ctx.actor.id);
        const outcome = await deliverTicketReply(ctx, pending.target_id, body);
        await ctx.api.sendMessage(
          ctx.chatId,
          outcome === 'sent' ? fa.adminTicketSent : fa.adminTicketStale,
        );
        return;
      }
      if (pending.action === 'wallet_grant' || pending.action === 'wallet_debit') {
        // Only a VALID amount consumes the arming; garbage keeps it alive.
        const consumed = await completeArmedWalletAction(ctx, pending, text);
        if (consumed) await clearPendingAdminAction(ctx.db, ctx.actor.id);
        return;
      }
      // action === 'reject': unchanged Phase 4 behavior.
      if (!pending.order_id) {
        await clearPendingAdminAction(ctx.db, ctx.actor.id);
        await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
        return;
      }
      const reason = sanitizeRejectionReason(text);
      if (reason === null) {
        // too long / empty: pending action stays, ask again
        await ctx.api.sendMessage(
          ctx.chatId,
          fa.adminRejectPromptMsg,
          adminRejectPromptKeyboard(),
        );
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

  // ———— Phase 7: support ticket body (fresh from the ladder, or follow-up
  // on an open ticket while IDLE — one indexed lookup, DB is the truth) ————
  if (session.state === 'WAITING_SUPPORT_MESSAGE') {
    await submitSupportText(ctx, session, text);
    return;
  }

  // ———— Phase 7: announcement draft ————
  if (session.state === 'WAITING_ANNOUNCE_TEXT') {
    await saveAnnounceDraft(ctx, session, text);
    return;
  }

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
    if (session.state === 'WAITING_ANNOUNCE_CONFIRM') {
      await ctx.api.sendMessage(ctx.chatId, fa.supportQueueChoice, backToMenuKeyboard());
      return;
    }
    // While IDLE with a live ticket, ordinary text becomes a follow-up —
    // only when the customer explicitly entered support before (state is
    // otherwise unchanged): we route it to the ticket ONLY if one is open.
    if (ctx.isAdmin === false) {
      const live = await findLiveTicketSafe(ctx.db, ctx.customerId);
      if (live) {
        const body = sanitizeSupportBody(text);
        if (body !== null) {
          await submitSupportText(ctx, null, body);
          return;
        }
      }
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

  // WAITING_CONFIG_NAME — strict English (>=3 words) display name; the
  // auto-pick button stays available on refusals.
  const name = validateConfigName(text);
  if (!name) {
    await ctx.api.sendMessage(ctx.chatId, fa.configNameInvalid, configNameKeyboard());
    return;
  }
  await continueWithConfigName(ctx, session, name);
}

/** Live-ticket lookup must never trap a customer in the idle path. */
async function findLiveTicketSafe(db: D1Database, customerId: number) {
  try {
    return await findLiveTicket(db, customerId);
  } catch {
    return null;
  }
}

function numericStepFor(state: string): StepKind | null {
  for (const [kind, expected] of Object.entries(STEP_EXPECTED_STATE) as [StepKind, string][]) {
    if (state === expected) return kind;
  }
  return null;
}

/**
 * Keyboard press of «🔙 بازگشت به منو» — the text-path twin of the
 * `act:back_menu` callback in `handleCallback`: admin arming clears first,
 * a busy flow is cancelled, IDLE just re-presents the main menu. Every
 * branch restores the main Reply Keyboard (the composing keyboards replaced
 * it while free text was awaited).
 */
async function handleBackToMenuText(ctx: UpdateContext): Promise<void> {
  if (ctx.isAdmin) {
    const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
    if (pending) {
      await clearPendingAdminAction(ctx.db, ctx.actor.id);
      await ctx.api.sendMessage(
        ctx.chatId,
        fa.adminRejectCancelled,
        mainMenuKeyboard(),
      );
      return;
    }
  }
  const session = await getSession(ctx.db, ctx.customerId);
  if (!isBusy(session.state)) {
    // Phase 8B: a deliberate back-tap is NOT off-topic input — soft nudge,
    // the «مشتی…» fallback stays reserved for genuinely out-of-flow text.
    await ctx.api.sendMessage(ctx.chatId, fa.idleMenuNudge, mainMenuKeyboard());
    return;
  }
  await cancelToMenu(ctx); // clears session, sends menu
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
