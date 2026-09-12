import type { TelegramCallbackQuery, UpdateContext } from '../types.ts';
import { extractCallbackTarget, isValidCallbackData } from '../lib/validate.ts';
import { CB, isKnownCallback, mainMenuKeyboard, backToMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getCustomer } from '../db/customers.ts';
import { getSession, setSession } from '../db/states.ts';
import { isBusy, reduce } from '../state/machine.ts';
import { cancelToMenu } from './commands.ts';

/**
 * Callback-query router.
 *
 * Security model: callback data arrives over a user-editable payload, so it
 * must pass format validation AND the exact allowlist before any action.
 * Malformed/unknown data gets a neutral toast and zero state changes.
 */
export async function handleCallback(
  ctx: UpdateContext,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const target = extractCallbackTarget(cb);
  const data = cb.data ?? '';
  const valid = isValidCallbackData(data) && isKnownCallback(data);

  if (!target || !valid) {
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

  switch (data as (typeof CB)[keyof typeof CB]) {
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
        await ctx.api.sendMessage(ctx.chatId, fa.buyInProgress, backToMenuKeyboard());
        return;
      }
      const afterBuy = reduce(session.state, 'buy'); // IDLE → BUYING
      if (afterBuy !== 'BUYING') return;
      await setSession(ctx.db, ctx.customerId, 'BUYING', session.data);
      await ctx.api.sendMessage(ctx.chatId, fa.buyIntro, backToMenuKeyboard());
      // Proven next move: the config-name step is where text capture begins.
      await setSession(
        ctx.db,
        ctx.customerId,
        reduce('BUYING', 'name_prompt_shown'),
        session.data,
      );
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
