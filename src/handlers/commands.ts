import type { UpdateContext } from '../types.ts';
import { clearSession } from '../db/states.ts';
import { mainMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { showPendingQueue } from './payment.ts';
import { showFailedQueue } from './provisioning.ts';
import { captureReferralOnStart, notifyReferralJoined } from './referrals.ts';
import { handleWalletAdminCommand } from './wallet.ts';
import { showTicketQueue } from './support.ts';
import { startAnnounceDraft, showAnnouncements, saveAnnounceDraft } from './announcements.ts';
import { parseCommand } from '../lib/validate.ts';
import { getSession } from '../db/states.ts';

/**
 * Slash-command handlers. Customer registration already happened in the
 * dispatcher; these stay thin: DB state cleanup + one Telegram call.
 */
export async function handleCommand(
  ctx: UpdateContext,
  text: string,
): Promise<void> {
  // Phase 7 first: /credit /debit (wallet-gated) and their arg form.
  const walletResult = await handleWalletAdminCommand(ctx, text);
  if (walletResult === 'handled') return;

  const parsed = parseCommand(text);
  if (!parsed) return;

  switch (parsed.name) {
    case 'start': {
      // Referral deep-link capture (dispatcher probed first-ever status).
      if (ctx.pendingReferralCode) {
        const referrer = await captureReferralOnStart(ctx, ctx.pendingReferralCode);
        if (referrer !== null) void notifyReferralJoined(ctx, referrer);
      }
      await showMenu(ctx);
      return;
    }
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
    case 'tickets':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
      } else {
        await showTicketQueue(ctx);
      }
      return;
    case 'announce': {
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
        return;
      }
      const session = await getSession(ctx.db, ctx.customerId);
      const inline = /^\/announce(@\w+)?\s+([\s\S]+)$/.exec(text);
      if (inline && inline[2]) {
        // inline text: /announce <text…> goes straight to the draft handler
        await saveAnnounceDraft(
          ctx,
          { state: 'WAITING_ANNOUNCE_TEXT', data: {} },
          inline[2],
        );
        return;
      }
      await startAnnounceDraft(ctx, session);
      return;
    }
    case 'announcements':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
      } else {
        await showAnnouncements(ctx);
      }
      return;
    default:
      await ctx.api.sendMessage(ctx.chatId, fa.cmdUnknown, mainMenuKeyboard());
  }
}

export async function showMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  // Phase 8B: «درود زیبا» when no first name is known (configname.test and
  // phase8b.test pin the greeting wording and its forbidden variant).
  const greeting = fa.welcomeGreeting(ctx.actor.first_name || null);
  await ctx.api.sendMessage(
    ctx.chatId,
    `${greeting}\n${fa.welcomeIntro}\n\n${fa.menuPrompt}`,
    mainMenuKeyboard(),
  );
}

/** Shared by /cancel and the back button: always lands on IDLE + menu. */
export async function cancelToMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  await ctx.api.sendMessage(ctx.chatId, fa.cancelled, mainMenuKeyboard());
}
