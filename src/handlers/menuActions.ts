/**
 * Phase 8A: the main-menu shortcuts, shared by BOTH transports so no business
 * logic is duplicated:
 *  - inline buttons on legacy bubbles still deliver `menu:*` callback data;
 *  - Reply Keyboard taps arrive as the button TEXT and are mapped through
 *    `menuCallbackForText` in `handleText`.
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
import { fa } from '../telegram/texts.ts';
import { getCustomer } from '../db/customers.ts';
import { setSession } from '../db/states.ts';
import { isBusy, reduce } from '../state/machine.ts';
import { loadCatalog } from '../catalog/catalog.ts';
import { showMyOrders } from './payment.ts';
import { showMyServices } from './services.ts';
import { showMyWallet } from './wallet.ts';
import { showInvite } from './referrals.ts';
import { openSupportEntry } from './support.ts';
import { resumeRenewal } from './renewal.ts';
import { sendSummary, stepView } from './purchase.ts';

/** The seven main-menu shortcuts rendered on the Reply Keyboard. */
const MENU_SHORTCUTS: readonly string[] = [
  CB.MENU_BUY,
  CB.MENU_SERVICES,
  CB.MENU_ORDERS,
  CB.MENU_ACCOUNT,
  CB.MENU_WALLET,
  CB.MENU_INVITE,
  CB.MENU_SUPPORT,
];

export function isMenuShortcut(callback: string): callback is KnownCallback {
  return (MENU_SHORTCUTS as readonly string[]).includes(callback);
}

/** `menu:buy` — re-enter the active step or start fresh (moved verbatim). */
async function startPurchase(ctx: UpdateContext, session: Session): Promise<void> {
  if (session.state === 'WAITING_CONFIG_NAME') {
    await ctx.api.sendMessage(ctx.chatId, fa.buyWaitingConfigName, configNameKeyboard());
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
    } else if (
      session.state === 'WAITING_RENEWAL_DURATION' ||
      session.state === 'WAITING_RENEWAL_CONFIRMATION'
    ) {
      await resumeRenewal(ctx, session, loaded.catalog);
    } else {
      const view = stepView(session.state, loaded.catalog);
      if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
    }
    return;
  }
  const afterBuy = reduce(session.state, 'buy'); // IDLE → BUYING
  if (afterBuy !== 'BUYING') return;
  await setSession(ctx.db, ctx.customerId, 'BUYING', session.data);
  await ctx.api.sendMessage(ctx.chatId, fa.buyIntro, configNameKeyboard());
  // The config-name step is where text capture begins.
  await setSession(ctx.db, ctx.customerId, reduce('BUYING', 'name_prompt_shown'), session.data);
}

/**
 * Runs one main-menu shortcut against the CURRENT session (the code the
 * callback switch used to hold inline). Returns false for anything other
 * than the seven shortcuts — the caller keeps owning the rest of the
 * callback vocabulary.
 */
export async function runMainMenuAction(
  ctx: UpdateContext,
  session: Session,
  callback: KnownCallback,
): Promise<boolean> {
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
      await openSupportEntry(ctx, session);
      return true;
    case CB.MENU_ACCOUNT: {
      const record = await getCustomer(ctx.db, ctx.actor.id);
      const lines = [
        fa.accountHeader,
        fa.accountUsername(record?.telegram_username ?? fa.accountNone),
        fa.accountLanguage(record?.language_code ?? fa.accountNone),
        record ? fa.accountSince(record.created_at.slice(0, 10)) : '',
        isBusy(session.state) ? fa.accountStatusBusy : fa.accountStatusIdle,
      ].filter(Boolean);
      await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), mainMenuKeyboard());
      return true;
    }
    default:
      return false;
  }
}
