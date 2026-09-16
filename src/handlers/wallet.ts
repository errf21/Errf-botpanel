/**
 * Phase 7 wallet surface: the customer's balance/ledger view, admin
 * grant/debit (arm → amount → guarded apply), and the shared wallet-credit
 * lookup used by checkout. Same rules as everywhere else: values from
 * keyboards/args are re-validated server-side; money moves with exactly-one
 * UPDATEs; a disabled/malformed `wallet` doc degrades to "not available".
 */
import type { UpdateContext } from '../types.ts';
import { getBalance, listWalletEntries, type WalletEntryRow } from '../db/wallet.ts';
import { loadWalletConfig, type WalletConfig } from '../catalog/wallet.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { getCustomer, getCustomerByUsername } from '../db/customers.ts';
import { backToMenuKeyboard, composingKeyboard, walletViewKeyboard } from '../telegram/menu.ts';
import { fa, faAdmin, formatPrice } from '../telegram/texts.ts';
import { FA_UI } from '../telegram/i18n.ts';
import { parseCommand, parseUsernameTarget, parseWalletAmount } from '../lib/validate.ts';
import { applyWalletMutation } from '../db/wallet.ts';
import {
  clearPendingAdminAction,
  setPendingAdminWalletAction,
} from '../db/admin_actions.ts';

const LEDGER_LIMIT = 8;

export async function loadWalletViewConfig(db: D1Database): Promise<WalletConfig | null> {
  const loaded = await loadWalletConfig(db);
  return loaded.ok ? loaded.config : null;
}

/** `menu:wallet` — balance + last entries, degrade-safe. */
export async function showMyWallet(ctx: UpdateContext): Promise<void> {
  const { t, f } = ctx.ui;
  const config = await loadWalletViewConfig(ctx.db);
  if (!config || !config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const [balance, entries] = await Promise.all([
    getBalance(ctx.db, ctx.customerId),
    listWalletEntries(ctx.db, ctx.customerId, LEDGER_LIMIT),
  ]);
  const lines: string[] = [
    t.walletHeader,
    t.walletBalance(f.price(balance ?? 0, 'IRT')),
  ];
  if (entries.length === 0) {
    lines.push(t.walletEmpty);
  } else {
    entries.forEach((entry, index) => {
      lines.push(
        t.walletEntry(
          index + 1,
          entry.delta_irt > 0 ? '➕' : '➖',
          t.walletKind(entry.kind),
          f.price(Math.abs(entry.delta_irt), 'IRT'),
          f.date(entry.created_at),
        ),
      );
    });
  }
  // Phase 17: top-up entry lives on the wallet view. Hidden while sales are
  // stopped (server gates below enforce the same rule for stale taps).
  let showTopup = true;
  try {
    showTopup = !(await isSalesStopped(ctx.db));
  } catch {
    showTopup = true;
  }
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), walletViewKeyboard(ctx.ui, showTopup));
}

/* ———— Admin money commands: /credit, /debit ————
 * Flow: /credit <telegram_id> [amount] → (arm) → amount via text (or the
 * command arg itself) → guarded apply with a preview line. Arming lives in
 * admin_actions (15-min TTL) exactly like the reject-reason prompt. */

export async function handleWalletAdminCommand(
  ctx: UpdateContext,
  text: string,
): Promise<'handled' | 'not-wallet-cmd'> {
  const parsed = parseCommand(text);
  if (!parsed || (parsed.name !== 'credit' && parsed.name !== 'debit')) {
    return 'not-wallet-cmd';
  }
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cmdAdminOnly);
    return 'handled';
  }
  const config = await loadWalletViewConfig(ctx.db);
  if (!config || !config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletUnavailable);
    return 'handled';
  }
  const [targetRaw = '', amountRaw = ''] = parsed.args;
  const grant = parsed.name === 'credit';
  const usage = faAdmin.walletUsage(grant);
  // Phase 17: numeric Telegram id stays canonical; @username is lookup-only.
  let record = null;
  const targetTg = parsePositiveId(targetRaw);
  if (targetTg !== null) {
    if (targetTg === ctx.actor.id) {
      await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
      return 'handled';
    }
    record = await getCustomer(ctx.db, targetTg);
    if (!record) {
      await ctx.api.sendMessage(ctx.chatId, fa.walletTargetUser(fa.accountNone));
      return 'handled';
    }
  } else {
    const username = parseUsernameTarget(targetRaw);
    if (username === null) {
      await ctx.api.sendMessage(ctx.chatId, `${usage}\n${faAdmin.walletUsageExample}`);
      return 'handled';
    }
    record = await getCustomerByUsername(ctx.db, username);
    if (!record) {
      await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.topupUserNotFound);
      return 'handled';
    }
    if (Number(record.telegram_user_id) === ctx.actor.id) {
      await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
      return 'handled';
    }
  }
  const resolvedTg = Number(record.telegram_user_id);
  if (!Number.isSafeInteger(resolvedTg) || resolvedTg <= 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletTargetUser(fa.accountNone));
    return 'handled';
  }
  const amount = parseWalletAmount(amountRaw);
  if (amount === null || amount.sign !== 1) {
    // arm via text interception if no valid amount given inline
    await setPendingAdminWalletAction(ctx.db, ctx.actor.id, grant ? 'wallet_grant' : 'wallet_debit', resolvedTg);
    // Phase 8A: admin now types the amount as free text — hide the main keyboard.
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.walletPromptAmount(grant ? faAdmin.walletVerbAdd : faAdmin.walletVerbSub)}\n${fa.walletTargetUser(`@${record.telegram_username ?? record.telegram_user_id}`)}`,
      composingKeyboard(FA_UI),
    );
    return 'handled';
  }
  await applyWalletAdminAction(ctx, record.id, grant, amount.amount);
  return 'handled';
}

/** Consumes an armed wallet action from handleText's admin intercept.
 *  Returns true ONLY when the arming can be cleared (valid apply or a dead
 *  target); a malformed amount keeps the action armed. Also clears any
 *  stale arming itself on the success paths. */
export async function completeArmedWalletAction(
  ctx: UpdateContext,
  pending: { action: string; target_id: string | null },
  text: string,
): Promise<boolean> {
  const parsed = parseWalletAmount(text);
  if (parsed === null || parsed.sign !== 1) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletAmountInvalid);
    return false;
  }
  const targetTg = parsePositiveId(pending.target_id ?? '');
  if (targetTg === null) return true;
  const record = await getCustomer(ctx.db, targetTg);
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletTargetUser(fa.accountNone));
    return true;
  }
  await applyWalletAdminAction(ctx, record.id, pending.action === 'wallet_grant', parsed.amount);
  return true;
}

async function applyWalletAdminAction(
  ctx: UpdateContext,
  targetCustomerId: number,
  grant: boolean,
  amountIrt: number,
): Promise<void> {
  const config = await loadWalletViewConfig(ctx.db);
  if (!config || !config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletUnavailable);
    await clearPendingAdminAction(ctx.db, ctx.actor.id);
    return;
  }
  const cap = grant ? config.maxCreditIrt : config.maxDebitIrt;
  if (amountIrt > cap) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletAmountTooBig(formatPrice(cap, 'IRT')));
    return;
  }
  const result = await applyWalletMutation(ctx.db, {
    customerId: targetCustomerId,
    amountIrt: grant ? amountIrt : -amountIrt,
    kind: grant ? 'admin_grant' : 'admin_debit',
    actor: `admin:${String(ctx.actor.id)}`,
  });
  if (!result.ok) {
    await ctx.api.sendMessage(
      ctx.chatId,
      result.reason === 'insufficient' ? fa.walletBalanceLow : fa.walletAmountInvalid,
    );
    return;
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    grant
      ? fa.walletGranted(formatPrice(amountIrt, 'IRT'))
      : fa.walletDebited(formatPrice(amountIrt, 'IRT')),
  );
}

function parsePositiveId(raw: string): number | null {
  const text = String(raw ?? '').trim();
  if (!/^[0-9\u06F0-\u06F9\u0660-\u0669]{1,20}$/.test(text)) return null;
  const normalized = text
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const num = Number(normalized);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/** Balance helper used by checkout screens (null = wallet unavailable). */
export async function payableWalletBalance(db: D1Database, customerId: number): Promise<number | null> {
  const config = await loadWalletViewConfig(db);
  if (!config || !config.enabled) return null;
  return getBalance(db, customerId);
}
