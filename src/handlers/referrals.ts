/**
 * Phase 7 referral surface: the invite screen (code + deep link, lazily
 * minted), and the payout notify pair. Business rules live in
 * db/referrals.ts + the `referral` settings doc; this file only renders.
 */
import type { TelegramApiLike, UpdateContext } from '../types.ts';
import { attributeReferral, ensureReferralCode, referralStats } from '../db/referrals.ts';
import { loadReferralConfig } from '../catalog/referral.ts';
import { getCustomerContact } from '../db/customers.ts';
import { backToMenuKeyboard } from '../telegram/menu.ts';
import { uiFor } from '../telegram/i18n.ts';

export const REFERRAL_CODE_PREFIX = 'ref_';

/** `menu:invite` — own link + lifetime stats. */
export async function showInvite(ctx: UpdateContext): Promise<void> {
  const { t, f } = ctx.ui;
  const loaded = await loadReferralConfig(ctx.db);
  const code = await ensureReferralCode(ctx.db, ctx.customerId);
  if (!code) {
    await ctx.api.sendMessage(ctx.chatId, t.referralUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const username = await botUsername(ctx.api);
  const stats = await referralStats(ctx.db, ctx.customerId);
  const lines: string[] = [t.inviteHeader];
  if (username !== null) {
    lines.push(t.inviteLinkNone(`https://t.me/${username}?start=${REFERRAL_CODE_PREFIX}${code}`));
  }
  lines.push(t.inviteHowTo);
  lines.push(t.inviteCount(stats.referees));
  if (loaded.ok) {
    lines.push(t.inviteEarned(f.price(stats.earnedIrt, 'IRT')));
    lines.push(t.inviteRewardPercent(f.digits(loaded.config.rewardPercent)));
  }
  await ctx.api.sendMessage(ctx.chatId, lines.filter(Boolean).join('\n\n'), backToMenuKeyboard(ctx.ui));
}

/** First-touch attribution for the code the dispatcher already extracted.
 *  Returns the referrer's customer id when attribution actually happened. */
export async function captureReferralOnStart(
  ctx: UpdateContext,
  code: string,
): Promise<number | null> {
  if (!code) return null;
  const attributed = await attributeReferral(ctx.db, {
    refereeCustomerId: ctx.customerId,
    code,
  });
  return attributed?.referrerCustomerId ?? null;
}

/** Payout notices (called from the approval path after a successful pay). */
export async function notifyReferralJoined(
  ctx: UpdateContext,
  referrerCustomerId: number,
): Promise<void> {
  const customer = await getCustomerContact(ctx.db, referrerCustomerId);
  const referrerChat = Number(customer?.telegram_user_id);
  if (!Number.isSafeInteger(referrerChat) || referrerChat <= 0) return;
  try {
    // Phase 10: the notice reads the REFERRER's persisted language.
    await ctx.api.sendMessage(referrerChat, uiFor(customer?.language).t.refNoticeJoined(String(ctx.actor.id)));
  } catch {
    /* never blocks registration */
  }
}

/** Payout notices (called from the approval path after a successful pay). */
export async function notifyReferralPaid(
  api: TelegramApiLike,
  db: D1Database,
  opts: {
    referrerCustomerId: number;
    refereeCustomerId: number;
    amountIrt: number;
  },
): Promise<void> {
  const [referrer, referee] = await Promise.all([
    getCustomerContact(db, opts.referrerCustomerId),
    getCustomerContact(db, opts.refereeCustomerId),
  ]);
  const refChat = Number(referrer?.telegram_user_id);
  if (Number.isSafeInteger(refChat) && refChat > 0) {
    // Phase 10: payout notices follow the RECIPIENT's language.
    const ui = uiFor(referrer?.language);
    await api.sendMessage(
      refChat,
      ui.t.refPaidToReferrer(ui.f.price(opts.amountIrt, 'IRT'), String(referee?.telegram_user_id ?? ui.t.accountNone)),
    );
  }
}

// In-isolate cache; the bot identity never changes during a warm instance.
let usernameCache: string | null | undefined;

async function botUsername(api: TelegramApiLike): Promise<string | null> {
  if (usernameCache !== undefined) return usernameCache;
  if (!api.getMe) return null;
  try {
    const me = await api.getMe();
    const username = typeof me?.['username'] === 'string' ? me['username'] : null;
    usernameCache = username;
    return username;
  } catch {
    return null;
  }
}

/** Test seam: drop the in-isolate / getMe cache. */
export function resetBotUsernameCache(): void {
  usernameCache = undefined;
}
