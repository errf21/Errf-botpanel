import type { UpdateContext } from '../types.ts';
import { clearSession } from '../db/states.ts';
import { mainMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { showPendingQueue } from './payment.ts';
import { showFailedQueue } from './provisioning.ts';
import { parseCommand } from '../lib/validate.ts';

/**
 * Slash-command handlers. Customer registration already happened in the
 * dispatcher; these stay thin: DB state cleanup + one Telegram call.
 */
export async function handleCommand(
  ctx: UpdateContext,
  text: string,
): Promise<void> {
  const parsed = parseCommand(text);
  if (!parsed) return;

  switch (parsed.name) {
    case 'start':
      await showMenu(ctx);
      return;
    case 'help':
      await ctx.api.sendMessage(ctx.chatId, fa.helpText, mainMenuKeyboard());
      return;
    case 'cancel':
      await cancelToMenu(ctx);
      return;
    case 'pending':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
      } else {
        await showPendingQueue(ctx);
      }
      return;
    case 'failed':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
      } else {
        await showFailedQueue(ctx);
      }
      return;
    default:
      await ctx.api.sendMessage(ctx.chatId, fa.cmdUnknown, mainMenuKeyboard());
  }
}

export async function showMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  const name = ctx.actor.first_name ? `${fa.welcomeHeader} ${ctx.actor.first_name}!` : fa.welcomeHeader;
  await ctx.api.sendMessage(
    ctx.chatId,
    `${name}\n${fa.welcomeIntro}\n\n${fa.menuPrompt}`,
    mainMenuKeyboard(),
  );
}

/** Shared by /cancel and the back button: always lands on IDLE + menu. */
export async function cancelToMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  await ctx.api.sendMessage(ctx.chatId, fa.cancelled, mainMenuKeyboard());
}
