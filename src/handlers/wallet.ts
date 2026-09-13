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
import { getCustomer } from '../db/customers.ts';
import { backToMenuKeyboard } from '../telegram/menu.ts';
import { digitsFa, fa, formatPrice } from '../telegram/texts.ts';
import { parseCommand, parseWalletAmount } from '../lib/validate.ts';
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

function entryLabel(entry: WalletEntryRow): string {
  switch (entry.kind) {
    case 'referral_reward':
      return fa.walletKindReferralReward;
    case 'admin_grant':
      return fa.walletKindAdminGrant;
    case 'admin_debit':
      return fa.walletKindAdminDebit;
    case 'order_payment':
      return fa.walletKindOrderPayment;
    case 'order_refund':
      return fa.walletKindOrderRefund;
    default:
      return entry.kind.slice(0, 24);
  }
}

/** `menu:wallet` — balance + last entries, degrade-safe. */
export async function showMyWallet(ctx: UpdateContext): Promise<void> {
  const config = await loadWalletViewConfig(ctx.db);
  if (!config || !config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletUnavailable, backToMenuKeyboard());
    return;
  }
  const [balance, entries] = await Promise.all([
    getBalance(ctx.db, ctx.customerId),
    listWalletEntries(ctx.db, ctx.customerId, LEDGER_LIMIT),
  ]);
  const lines: string[] = [
    fa.walletHeader,
    fa.walletBalance(formatPrice(balance ?? 0, 'IRT')),
  ];
  if (entries.length === 0) {
    lines.push(fa.walletEmpty);
  } else {
    entries.forEach((entry, index) => {
      lines.push(
        fa.walletEntry(
          index + 1,
          entry.delta_irt > 0 ? '➕' : '➖',
          entryLabel(entry),
          formatPrice(Math.abs(entry.delta_irt), 'IRT'),
          digitsFa(entry.created_at.slice(0, 10)),
        ),
      );
    });
  }
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), backToMenuKeyboard());
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
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return 'handled';
  }
  const config = await loadWalletViewConfig(ctx.db);
  if (!config || !config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletUnavailable);
    return 'handled';
  }
  const [targetRaw = '', amountRaw = ''] = parsed.args;
  const targetTg = parsePositiveId(targetRaw);
  const grant = parsed.name === 'credit';
  const usage = `${grant ? '/credit' : '/debit'} <شناسه تلگرام> <مبلغ>`;
  if (targetTg === null) {
    await ctx.api.sendMessage(ctx.chatId, `${usage}\nمثال: /credit 123456789 500000`);
    return 'handled';
  }
  if (targetTg === ctx.actor.id) {
    await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
    return 'handled';
  }
  const record = await getCustomer(ctx.db, targetTg);
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.walletTargetUser(fa.accountNone));
    return 'handled';
  }
  const amount = parseWalletAmount(amountRaw);
  if (amount === null || amount.sign !== 1) {
    // arm via text interception if no valid amount given inline
    await setPendingAdminWalletAction(ctx.db, ctx.actor.id, grant ? 'wallet_grant' : 'wallet_debit', targetTg);
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.walletPromptAmount(grant ? 'افزودن' : 'کسر')}\n${fa.walletTargetUser(`@${record.telegram_username ?? record.telegram_user_id}`)}`,
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
