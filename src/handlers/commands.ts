import type { UpdateContext } from '../types.ts';
import { clearSession } from '../db/states.ts';
import { mainMenuKeyboard } from '../telegram/menu.ts';
import { showPendingQueue } from './payment.ts';
import { showFailedQueue } from './provisioning.ts';
import { captureReferralOnStart, notifyReferralJoined } from './referrals.ts';
import { handleWalletAdminCommand } from './wallet.ts';
import { showTicketQueue } from './support.ts';
import { startAnnounceDraft, showAnnouncements, saveAnnounceDraft } from './announcements.ts';
import { showPricing } from './pricingAdmin.ts';
import { parseCommand } from '../lib/validate.ts';
import { getSession } from '../db/states.ts';

/**
 * Slash-command handlers. Customer registration already happened in the
 * dispatcher; these stay thin: DB state cleanup + one Telegram call.
 * Phase 10: customer-facing replies render in `ctx.ui`; admin queue commands
 * stay Persian regardless of the admin's personal (customer-side) choice.
 */
export async function handleCommand(
  ctx: UpdateContext,
  text: string,
): Promise<void> {
  const t = ctx.ui.t;
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
      await ctx.api.sendMessage(ctx.chatId, t.helpText, mainMenuKeyboard(ctx.ui));
      return;
    case 'cancel':
      await cancelToMenu(ctx);
      return;
    case 'pending':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showPendingQueue(ctx);
      }
      return;
    case 'failed':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showFailedQueue(ctx);
      }
      return;
    case 'tickets':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showTicketQueue(ctx);
      }
      return;
    case 'announce': {
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
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
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showAnnouncements(ctx);
      }
      return;
    case 'pricing':
      // Phase 12: pricing view doubles as the entry to the edit flow.
      await showPricing(ctx);
      return;
    default:
      await ctx.api.sendMessage(ctx.chatId, t.cmdUnknown, mainMenuKeyboard(ctx.ui));
  }
}

export async function showMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  const t = ctx.ui.t;
  // Phase 8B: «درود زیبا» when no first name is known (configname.test and
  // phase8b.test pin the greeting wording and its forbidden variant). In
  // English the same slot carries the bundle's own native greeting.
  const greeting = t.welcomeGreeting(ctx.actor.first_name || null);
  await ctx.api.sendMessage(
    ctx.chatId,
    `${greeting}\n${t.welcomeIntro}\n\n${t.menuPrompt}`,
    mainMenuKeyboard(ctx.ui),
  );
}

/** Shared by /cancel and the back button: always lands on IDLE + menu. */
export async function cancelToMenu(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
  await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cancelled, mainMenuKeyboard(ctx.ui));
}
