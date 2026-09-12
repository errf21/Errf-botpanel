import type { TelegramCallbackQuery, UpdateContext } from '../types.ts';
import {
  extractCallbackTarget,
  isValidCallbackData,
  parseAdminCallback,
} from '../lib/validate.ts';
import {
  CB,
  adminRejectPromptKeyboard,
  isKnownCallback,
  mainMenuKeyboard,
  backToMenuKeyboard,
  routeCallback,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getCustomer } from '../db/customers.ts';
import { getSession, setSession } from '../db/states.ts';
import {
  clearPendingAdminAction,
  getPendingAdminAction,
  setPendingAdminAction,
} from '../db/admin_actions.ts';
import { performAdminReview, retireAdminMessage, type ReviewResult } from '../admin.ts';
import { isBusy, reduce } from '../state/machine.ts';
import { loadCatalog, type StepKind } from '../catalog/catalog.ts';
import { showMyOrders } from './payment.ts';
import {
  STEP_EXPECTED_STATE,
  applyStepChoice,
  confirmPurchase,
  goBack,
  sendSummary,
  stepView,
} from './purchase.ts';
import { cancelToMenu } from './commands.ts';

/**
 * Callback-query router.
 *
 * Security model: callback data arrives over a user-editable payload, so it
 * must pass format validation AND the exact allowlist (or a known option
 * namespace whose VALUE is then re-validated against the fresh DB catalog)
 * before any action. Malformed/unknown data gets a neutral toast and zero
 * state changes.
 */
export async function handleCallback(
  ctx: UpdateContext,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const target = extractCallbackTarget(cb);
  const data = cb.data ?? '';
  if (!target || !isValidCallbackData(data)) {
    if (target) await ctx.api.answerCallbackQuery(target.callbackQueryId, fa.invalidChoice);
    return;
  }

  const { callbackQueryId, messageChatId, messageId } = target;

  // ———— admin review callbacks: authorization BEFORE anything else ————
  if (data.startsWith('adm:')) {
    await handleAdminCallback(ctx, data, callbackQueryId, messageChatId, messageId);
    return;
  }

  const session = await getSession(ctx.db, ctx.customerId);

  const replyToMenu = async (text: string): Promise<void> => {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    if (messageChatId !== null && messageId !== null && messageChatId === ctx.chatId) {
      await ctx.api.editMessageText(messageChatId, messageId, text, mainMenuKeyboard());
    } else {
      await ctx.api.sendMessage(ctx.chatId, text, mainMenuKeyboard());
    }
  };

  const route = routeCallback(data);

  // ———— catalog-driven option steps (vol:/dur:/dev:) ————
  if (route.kind === 'option') {
    const kind: StepKind =
      route.namespace === 'vol' ? 'volume' : route.namespace === 'dur' ? 'duration' : 'device';
    if (session.state !== STEP_EXPECTED_STATE[kind]) {
      await ctx.api.answerCallbackQuery(callbackQueryId, fa.staleChoice, true);
      return;
    }
    const loaded = await loadCatalog(ctx.db);
    if (!loaded.ok) {
      await ctx.api.answerCallbackQuery(callbackQueryId, fa.catalogUnavailable, true);
      return;
    }
    if (route.value === 'custom') {
      await ctx.api.answerCallbackQuery(callbackQueryId, fa.customHint, true);
      return;
    }
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await applyStepChoice(ctx, session, loaded.catalog, kind, route.value);
    return;
  }

  if (route.kind !== 'known' || !isKnownCallback(data)) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.invalidChoice);
    return;
  }

  // ———— static vocabulary ————
  switch (route.callback) {
    case CB.ACT_CANCEL:
    case CB.ACT_BACK_MENU: {
      if (ctx.isAdmin) {
        const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
        if (pending) {
          await clearPendingAdminAction(ctx.db, ctx.actor.id);
          await ctx.api.answerCallbackQuery(callbackQueryId, fa.adminRejectCancelled);
          return;
        }
      }
      if (!isBusy(session.state)) {
        await replyToMenu(fa.idleInputHint);
        return;
      }
      await ctx.api.answerCallbackQuery(callbackQueryId);
      await cancelToMenu(ctx); // clears session, sends menu
      return;
    }

    case CB.MENU_BUY: {
      await ctx.api.answerCallbackQuery(callbackQueryId);
      if (session.state === 'WAITING_CONFIG_NAME') {
        await ctx.api.sendMessage(ctx.chatId, fa.buyWaitingConfigName, backToMenuKeyboard());
        return;
      }
      if (isBusy(session.state)) {
        // Re-entering an active flow: redraw the CURRENT step (state preserved).
        const loaded = await loadCatalog(ctx.db);
        if (!loaded.ok) {
          await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
          return;
        }
        if (session.state === 'WAITING_ORDER_CONFIRMATION') {
          await sendSummary(ctx, session, loaded.catalog);
        } else if (session.state === 'WAITING_PAYMENT_RECEIPT') {
          await ctx.api.sendMessage(ctx.chatId, fa.paymentWaitNotice, backToMenuKeyboard());
        } else {
          const view = stepView(session.state, loaded.catalog);
          if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
        }
        return;
      }
      const afterBuy = reduce(session.state, 'buy'); // IDLE → BUYING
      if (afterBuy !== 'BUYING') return;
      await setSession(ctx.db, ctx.customerId, 'BUYING', session.data);
      await ctx.api.sendMessage(ctx.chatId, fa.buyIntro, backToMenuKeyboard());
      // The config-name step is where text capture begins.
      await setSession(ctx.db, ctx.customerId, reduce('BUYING', 'name_prompt_shown'), session.data);
      return;
    }

    case CB.STEP_BACK: {
      const loaded = await loadCatalog(ctx.db);
      if (!loaded.ok) {
        await ctx.api.answerCallbackQuery(callbackQueryId, fa.catalogUnavailable, true);
        return;
      }
      await goBack(ctx, session, loaded.catalog, callbackQueryId);
      return;
    }

    case CB.ORDER_CONFIRM: {
      const loaded = await loadCatalog(ctx.db);
      if (!loaded.ok) {
        await ctx.api.answerCallbackQuery(callbackQueryId, fa.catalogUnavailable, true);
        return;
      }
      await confirmPurchase(ctx, session, loaded.catalog, callbackQueryId);
      return;
    }

    case CB.MENU_SERVICES:
      await replyToMenu(fa.comingSoonServices);
      return;
    case CB.MENU_ORDERS: {
      await ctx.api.answerCallbackQuery(callbackQueryId);
      await showMyOrders(ctx);
      return;
    }
    case CB.MENU_SUPPORT:
      await replyToMenu(fa.comingSoonSupport);
      return;

    case CB.MENU_ACCOUNT: {
      const record = await getCustomer(ctx.db, ctx.actor.id);
      const lines = [
        fa.accountHeader,
        fa.accountUsername(record?.telegram_username ?? fa.accountNone),
        fa.accountLanguage(record?.language_code ?? fa.accountNone),
        record ? fa.accountSince(record.created_at.slice(0, 10)) : '',
        isBusy(session.state) ? fa.accountStatusBusy : fa.accountStatusIdle,
      ].filter(Boolean);
      await replyToMenu(lines.join('\n'));
      return;
    }
  }
}

/**
 * Handles `adm:ok:` / `adm:no:` / `adm:skip:`. Called ONLY after the callback
 * passed format validation AND the actor is a verified admin, so every branch
 * can assume `data` matches the strict admin pattern.
 */
async function handleAdminCallback(
  ctx: UpdateContext,
  data: string,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  const parsed = parseAdminCallback(data);
  if (!ctx.isAdmin || !parsed) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.invalidChoice);
    return;
  }
  const { action, orderId } = parsed;

  if (action === 'ok') {
    const result = await performAdminReview({
      db: ctx.db,
      api: ctx.api,
      actorId: ctx.actor.id,
      orderId,
      decision: 'approve',
    });
    await finishAdminReview(ctx, result, callbackQueryId, messageChatId, messageId);
    return;
  }

  if (action === 'no') {
    await setPendingAdminAction(ctx.db, ctx.actor.id, orderId);
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(
      ctx.chatId,
      fa.adminRejectPromptMsg,
      adminRejectPromptKeyboard(orderId),
    );
    return;
  }

  // action === 'skip': only meaningful with a live pending reject for THIS order.
  const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
  if (!pending || pending.order_id !== orderId) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.invalidChoice);
    return;
  }
  await clearPendingAdminAction(ctx.db, ctx.actor.id);
  const result = await performAdminReview({
    db: ctx.db,
    api: ctx.api,
    actorId: ctx.actor.id,
    orderId,
    decision: 'reject',
    reason: fa.adminRejectDefaultReason,
  });
  await finishAdminReview(ctx, result, callbackQueryId, messageChatId, messageId);
}

/** Shared outcome reporting for approve/skip-reject button presses. */
async function finishAdminReview(
  ctx: UpdateContext,
  result: ReviewResult,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  if (!result.ok) {
    await ctx.api.answerCallbackQuery(
      callbackQueryId,
      result.error === 'not_found' || result.error === 'invalid_id'
        ? fa.invalidChoice
        : fa.adminStaleToast,
      true,
    );
    return;
  }

  const approved = result.order.state === 'approved';
  await ctx.api.answerCallbackQuery(
    callbackQueryId,
    approved ? fa.adminApprovedToast : fa.adminRejectedToast,
  );
  await retireAdminMessage(
    ctx.api,
    messageChatId,
    messageId,
    approved
      ? fa.adminProcessedApprove(result.order.id, String(ctx.actor.id))
      : fa.adminProcessedReject(result.order.id, String(ctx.actor.id)),
  );
}
