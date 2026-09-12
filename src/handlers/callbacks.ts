import type { TelegramCallbackQuery, UpdateContext } from '../types.ts';
import { extractCallbackTarget, isValidCallbackData } from '../lib/validate.ts';
import { CB, isKnownCallback, mainMenuKeyboard, backToMenuKeyboard, routeCallback } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getCustomer } from '../db/customers.ts';
import { getSession, setSession } from '../db/states.ts';
import { isBusy, reduce } from '../state/machine.ts';
import { loadCatalog, type StepKind } from '../catalog/catalog.ts';
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
    case CB.MENU_ORDERS:
      await replyToMenu(fa.comingSoonOrders);
      return;
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
