/**
 * Phase 8A: the main-menu shortcuts, shared by BOTH transports so no business
 * logic is duplicated:
 *  - inline buttons on legacy bubbles still deliver `menu:*` callback data;
 *  - Reply Keyboard taps arrive as the button TEXT and are mapped through
 *    `menuCallbackForText` in `handleText` (across ALL locales, Phase 10).
 * Every action re-reads the session server-side; nothing trusts the tap.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import {
  CB,
  backToMenuKeyboard,
  configNameKeyboard,
  mainMenuKeyboard,
  type KnownCallback,
} from '../telegram/menu.ts';
import { getCustomer } from '../db/customers.ts';
import { localeName } from '../telegram/i18n.ts';
import { setSession } from '../db/states.ts';
import { isBusy, reduce } from '../state/machine.ts';
import { loadCatalog } from '../catalog/catalog.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { showMyOrders } from './payment.ts';
import { showMyServices } from './services.ts';
import { showMyWallet } from './wallet.ts';
import { resumeTopup } from './topup.ts';
import { showInvite } from './referrals.ts';
import { openSupportEntry, showDirectSupport } from './support.ts';
import { openGuide } from './guide.ts';
import { resumeRenewal } from './renewal.ts';
import { resumeRepurchase } from './repurchase.ts';
import { sendSummary, stepView } from './purchase.ts';

/** The nine main-menu shortcuts (every keyboard button except the language
 *  picker, which the callers own) — Phase 11 added the guide, and the support
 *  desk is now split into direct contact + the ticket ladder. */
const MENU_SHORTCUTS: readonly string[] = [
  CB.MENU_BUY,
  CB.MENU_SERVICES,
  CB.MENU_ORDERS,
  CB.MENU_ACCOUNT,
  CB.MENU_WALLET,
  CB.MENU_INVITE,
  CB.MENU_SUPPORT,
  CB.MENU_TICKET,
  /** Phase 11: stateless read-only screens — safe from IDLE and from busy. */
  CB.MENU_GUIDE,
];

export function isMenuShortcut(callback: string): callback is KnownCallback {
  return (MENU_SHORTCUTS as readonly string[]).includes(callback);
}

/** `menu:buy` — re-enter the active step or start fresh (moved verbatim). */
async function startPurchase(ctx: UpdateContext, session: Session): Promise<void> {
  const t = ctx.ui.t;
  if (session.state === 'WAITING_CONFIG_NAME') {
    await ctx.api.sendMessage(ctx.chatId, t.buyWaitingConfigName, configNameKeyboard(ctx.ui));
    return;
  }
  if (isBusy(session.state)) {
    // Re-entering an active flow: redraw the CURRENT step (state preserved).
    const loaded = await loadCatalog(ctx.db);
    if (!loaded.ok) {
      await ctx.api.sendMessage(ctx.chatId, t.catalogUnavailable, backToMenuKeyboard(ctx.ui));
      return;
    }
    if (session.state === 'WAITING_ORDER_CONFIRMATION') {
      await sendSummary(ctx, session, loaded.catalog);
    } else if (session.state === 'WAITING_PAYMENT_RECEIPT') {
      await ctx.api.sendMessage(ctx.chatId, t.paymentWaitNotice, backToMenuKeyboard(ctx.ui));
    } else if (
      session.state === 'WAITING_TOPUP_AMOUNT' ||
      session.state === 'WAITING_TOPUP_RECEIPT'
    ) {
      await resumeTopup(ctx);
    } else if (
      session.state === 'WAITING_RENEWAL_DURATION' ||
      session.state === 'WAITING_RENEWAL_CONFIRMATION'
    ) {
      await resumeRenewal(ctx, session, loaded.catalog);
    } else if (
      session.state === 'WAITING_REPURCHASE_MODE' ||
      session.state === 'WAITING_REPURCHASE_VOLUME' ||
      session.state === 'WAITING_REPURCHASE_DURATION' ||
      session.state === 'WAITING_REPURCHASE_DEVICE' ||
      session.state === 'WAITING_REPURCHASE_CONFIRMATION'
    ) {
      await resumeRepurchase(ctx, session, loaded.catalog);
    } else {
      const view = stepView(ctx.ui, session.state, loaded.catalog);
      if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
    }
    return;
  }
  // Phase 13: the commercial stop blocks FRESH purchase entry only — an
  // in-flight draft may still be resumed (its confirmation is gated where
  // the order would actually be created, so nothing can slip through).
  if (await isSalesStopped(ctx.db)) {
    await ctx.api.sendMessage(ctx.chatId, t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    return;
  }
  const afterBuy = reduce(session.state, 'buy'); // IDLE → BUYING
  if (afterBuy !== 'BUYING') return;
  await setSession(ctx.db, ctx.customerId, 'BUYING', session.data);
  await ctx.api.sendMessage(ctx.chatId, t.buyIntro, configNameKeyboard(ctx.ui));
  // The config-name step is where text capture begins.
  await setSession(ctx.db, ctx.customerId, reduce('BUYING', 'name_prompt_shown'), session.data);
}

/**
 * Runs one main-menu shortcut against the CURRENT session (the code the
 * callback switch used to hold inline). Returns false for anything other
 * than the nine shortcuts — the caller keeps owning the rest of the
 * callback vocabulary (`menu:lang` and `gud:*` included).
 */
export async function runMainMenuAction(
  ctx: UpdateContext,
  session: Session,
  callback: KnownCallback,
): Promise<boolean> {
  const t = ctx.ui.t;
  switch (callback) {
    case CB.MENU_BUY:
      await startPurchase(ctx, session);
      return true;
    case CB.MENU_SERVICES:
      await showMyServices(ctx);
      return true;
    case CB.MENU_ORDERS:
      await showMyOrders(ctx);
      return true;
    case CB.MENU_WALLET:
      await showMyWallet(ctx);
      return true;
    case CB.MENU_INVITE:
      await showInvite(ctx);
      return true;
    case CB.MENU_SUPPORT:
      // Direct contact: never a ticket write, never a state change.
      await showDirectSupport(ctx);
      return true;
    case CB.MENU_TICKET:
      // The formal, trackable ladder (session + support_tickets + admin relay).
      await openSupportEntry(ctx, session);
      return true;
    case CB.MENU_GUIDE:
      // Phase 11: read-only; the session is passed but never touched.
      await openGuide(ctx);
      return true;
    case CB.MENU_ACCOUNT: {
      const record = await getCustomer(ctx.db, ctx.actor.id);
      const none = t.accountNone;
      const lines = [
        t.accountHeader,
        t.accountUsername(record?.telegram_username ?? none),
        // Phase 10: the EFFECTIVE bot language first, the Telegram client
        // hint beneath it (hint is display-only and never selects a language).
        t.accountBotLanguage(localeName(ctx.ui)),
        t.accountLanguage(record?.language_code ?? none),
        record ? t.accountSince(record.created_at.slice(0, 10)) : '',
        isBusy(session.state) ? t.accountStatusBusy : t.accountStatusIdle,
      ].filter(Boolean);
      await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), mainMenuKeyboard(ctx.ui));
      return true;
    }
    default:
      return false;
  }
}
