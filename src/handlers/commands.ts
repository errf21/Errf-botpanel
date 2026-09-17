import type { UpdateContext } from '../types.ts';
import { clearSession } from '../db/states.ts';
import { mainMenuKeyboard } from '../telegram/menu.ts';
import { showPendingQueue } from './payment.ts';
import { showFailedQueue } from './provisioning.ts';
import { showActiveRepurchases } from './repurchaseAdmin.ts';
import { captureReferralOnStart, notifyReferralJoined } from './referrals.ts';
import { handleWalletAdminCommand } from './wallet.ts';
import { showTopupQueue } from './topup.ts';
import { showTicketQueue } from './support.ts';
import { startAnnounceDraft, showAnnouncements, saveAnnounceDraft } from './announcements.ts';
import { showPricing } from './pricingAdmin.ts';
import { showSalesStatus } from './salesAdmin.ts';
import { handleUsersCommand } from './usersAdmin.ts';
import { handleMsgCommand } from './msgAdmin.ts';
import { handlePanelDeleteCommand } from './panelDelete.ts';
import { maybeOfferFreeTestOnStart } from './freeTest.ts';
import { parseCommand } from '../lib/validate.ts';
import { getSession } from '../db/states.ts';
import { tgCode } from '../telegram/format.ts';

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
    case 'myid': {
      // Phase 17: numeric Telegram id straight from the verified update —
      // no DB read/write, no admin gate, never another user's id.
      // Tap-to-copy: <code> + parse_mode HTML is Telegram's real copy mechanism.
      const id = String(ctx.actor.id);
      await ctx.api.sendMessage(ctx.chatId, `${t.myId(tgCode(id))}\n📋 بزن روش، کپی میشه 😎`, undefined, 'HTML');
      return;
    }
    case 'start': {
      // Referral deep-link capture (dispatcher probed first-ever status).
      if (ctx.pendingReferralCode) {
        const referrer = await captureReferralOnStart(ctx, ctx.pendingReferralCode);
        if (referrer !== null) void notifyReferralJoined(ctx, referrer);
      }
      await showMenu(ctx);
      // Phase 15: the one-time free-test offer rides a SEPARATE bubble on the
      // FIRST-EVER /start only (the menu's Reply Keyboard can't also carry an
      // inline CTA — Telegram allows one markup per message, and the main
      // menu shape is a pinned contract). Fail-closed and claim-aware inside.
      if (ctx.firstEverStart) {
        await maybeOfferFreeTestOnStart(ctx);
      }
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
    case 'topups':
      // Phase 17: admin-only recovery view for top-up receipts (twin of /pending).
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showTopupQueue(ctx);
      }
      return;
    case 'failed':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showFailedQueue(ctx);
      }
      return;
    case 'repurchases':
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await showActiveRepurchases(ctx);
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
    case 'sales':
      // Phase 13: sales stop/resume — view doubles as the control surface
      // (admin gate lives INSIDE showSalesStatus, same precedent as /pricing).
      await showSalesStatus(ctx);
      return;
    case 'panel_del':
      // Phase 16: admin-only service deletion; the explicit confirmation card
      // is the second click. Args: one panel username or 28-char order id.
      if (!ctx.isAdmin) {
        await ctx.api.sendMessage(ctx.chatId, t.cmdAdminOnly);
      } else {
        await handlePanelDeleteCommand(ctx, parsed.args.join(' '));
      }
      return;
    case 'users':
      // Phase 20: admin-only users dashboard (overview + paginated browsing).
      // Bare /users opens the dashboard; /users <id|@username> jumps direct
      // (migration-free search). The admin gate lives inside the handler so
      // non-admins get the exact cmdAdminOnly denial with zero data leakage.
      await handleUsersCommand(ctx, parsed.args);
      return;
    case 'msg':
      // Phase 21: admin-only direct message relay (stateless, no D1 writes).
      // Gate + usage/not-found handling live inside the handler.
      await handleMsgCommand(ctx, parsed.args);
      return;
    default:
      // Task 1: an unknown command never re-presents the Reply Keyboard —
      // per Bot API docs a keyboard send makes clients display the panel again.
      await ctx.api.sendMessage(ctx.chatId, t.cmdUnknown);
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
