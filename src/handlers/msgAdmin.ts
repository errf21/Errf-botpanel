/**
 * Phase 21: /msg admin direct message.
 *
 * Stateless by design: no conversation state, no admin_actions arming, no D1
 * writes (so no migration — both CHECK lists stay untouched). The admin sends
 * `/msg <telegram_id|@username> <message>` and the bot relays it as a direct
 * Telegram message to the resolved user.
 *
 * Safety: admin gate first (exact cmdAdminOnly denial, zero leakage); target
 * re-resolved from D1 via the existing customer lookups; self-target refused
 * (same rule as /credit); the relay is sent as PLAIN TEXT (no parse_mode),
 * so special characters in the admin's message render literally and can
 * never break message formatting. Send failures are caught and reported to
 * the admin — the update never crashes.
 */
import type { UpdateContext } from '../types.ts';
import { getCustomer, getCustomerByUsername } from '../db/customers.ts';
import { parseUsernameTarget } from '../lib/validate.ts';
import { fa } from '../telegram/texts.ts';

const MSG_BODY_CAP = 3500;

/** Numeric telegram id with Persian/Arabic digit normalization (canonical lookup). */
function parseNumericTgid(raw: string): number | null {
  const normalized = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^[0-9]{1,20}$/.test(normalized)) return null;
  const num = Number(normalized);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/**
 * `/msg <telegram_id|@username> <message>` — admin-only direct relay.
 * `args` are the raw space-split tokens after the command name.
 */
export async function handleMsgCommand(ctx: UpdateContext, args: string[]): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const [targetRaw = '', ...bodyParts] = args;
  const body = bodyParts.join(' ').trim();
  if (!targetRaw.trim() || !body) {
    await ctx.api.sendMessage(ctx.chatId, fa.msgUsage);
    return;
  }

  // Resolve via the existing customer lookups (numeric stays canonical).
  let telegramId: string | null = null;
  const numeric = parseNumericTgid(targetRaw);
  if (numeric !== null) {
    const record = await getCustomer(ctx.db, numeric);
    telegramId = record ? record.telegram_user_id : null;
  } else {
    const username = parseUsernameTarget(targetRaw);
    if (username === null) {
      await ctx.api.sendMessage(ctx.chatId, fa.msgUsage);
      return;
    }
    const record = await getCustomerByUsername(ctx.db, username);
    telegramId = record ? record.telegram_user_id : null;
  }
  if (telegramId === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound);
    return;
  }
  if (Number(telegramId) === ctx.actor.id) {
    await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice);
    return;
  }
  const targetChatId = Number(telegramId);
  if (!Number.isSafeInteger(targetChatId) || targetChatId <= 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound);
    return;
  }

  const text = fa.msgFromAdmin(body.slice(0, MSG_BODY_CAP));
  // The Telegram client signals failure with null (never throws), but a
  // throwing transport must also converge here — either way the admin gets
  // an error notice and the update never crashes.
  const sent = await ctx.api.sendMessage(targetChatId, text).catch(() => null);
  if (!sent) {
    await ctx.api.sendMessage(ctx.chatId, fa.msgSendFailed);
    return;
  }
  await ctx.api.sendMessage(ctx.chatId, fa.msgSent);
}
