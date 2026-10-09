import {syncConfiguredPanels} from './panels/bindings.ts';
import type { Env, TelegramUpdate, UpdateContext } from './types.ts';
import { TelegramApi } from './telegram/api.ts';
import { uiFor } from './telegram/i18n.ts';
import { customerExists, upsertCustomer } from './db/customers.ts';
import { REFERRAL_CODE_PREFIX } from './handlers/referrals.ts';
import { claimUpdate, releaseUpdate } from './db/dedupe.ts';
import {
  extractReceiptMedia,
  isTelegramUpdate,
  isValidTelegramUserId,
  messageText,
} from './lib/validate.ts';
import { resolveIsAdmin } from './admin.ts';
import { handleCommand } from './handlers/commands.ts';
import { handleCallback } from './handlers/callbacks.ts';
import { handleMedia, handleText } from './handlers/messages.ts';

/**
 * Update dispatcher: structural validation → dedupe → customer registration
 * → route to handler. Identity is taken ONLY from update.from, never from
 * user-authored content.
 */
export async function processTelegramUpdate(
  update: unknown,
  env: Env,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<void> {
  if (!isTelegramUpdate(update)) return;
  if ((await claimUpdate(env.DB, update.update_id, { prune: false })) !== 'fresh') return; // webhook replay

  try {
    const callback = update.callback_query;
    const message = update.message ?? update.edited_message;

    const actor = callback?.from ?? message?.from;
    if (!actor || !isValidTelegramUserId(actor.id)) return;

    const rawChat = callback?.message?.chat?.id ?? message?.chat?.id;
    const chatId = typeof rawChat === 'number' && Number.isSafeInteger(rawChat)
      ? rawChat
      : actor.id;

    // Phase 7: FIRST-EVER /start with a referral arg only — the pre-probe
    // (one indexed SELECT) happens exclusively for those payloads.
    // Phase 15: the free-test offer needs the same "first /start ever" fact
    // for EVERY start (with or without a referral arg). The probe is still
    // gated to /start messages only — the hot path never pays for it.
    let pendingReferralCode: string | undefined;
    let firstEverStart = false;
    const startText = message?.text ?? message?.caption;
    const arg = referralArg(startText);
    if (arg || isStartCommand(startText)) {
      const neverSeen = message !== undefined && !(await customerExists(env.DB, actor.id));
      if (arg) {
        if (neverSeen) pendingReferralCode = arg;
      }
      if (isStartCommand(startText)) firstEverStart = neverSeen;
    }

    try{await syncConfiguredPanels(env);}catch{console.error('panel_binding_sync_failed');}
    // Phase 10: the upsert's own row read carries the explicit language
    // choice — resolution costs ZERO extra queries (NULL/Persian default).
    const { id: customerId, language, is_admin } = await upsertCustomer(env.DB, actor);
    const ctx: UpdateContext = {
      env,
      db: env.DB,
      api: new TelegramApi(env.TELEGRAM_BOT_TOKEN),
      actor,
      chatId,
      customerId,
      updateId:update.update_id,
      isAdmin: await resolveIsAdmin(env, env.DB, actor.id, is_admin),
      ui: uiFor(language),
      waitUntil: options?.waitUntil,
      ...(pendingReferralCode ? { pendingReferralCode } : {}),
      ...(firstEverStart ? { firstEverStart: true } : {}),
    };

    if (callback) {
      await handleCallback(ctx, callback);
      return;
    }

    const text = messageText(message);
    if (text !== null) {
      if (text.startsWith('/')) {
        await handleCommand(ctx, text);
        return;
      }
      await handleText(ctx, text);
      return;
    }

    // Phase 4: receipts arrive as photo/document (largest rendition).
    const receipt = extractReceiptMedia(message);
    if (receipt) await handleMedia(ctx, receipt);
  } catch (error) {
    // Never leak internals; keep a safe one-line record.
    const name = error instanceof Error ? error.name : 'unknown';
    console.error(`update_dispatch_failed update_id=${update.update_id} error=${name.slice(0, 200)}`);
    // Swallow (caller still returns 200 to stop retry storms) but release the
    // dedupe claim so a re-delivered update can be retried instead of dropped.
    await releaseUpdate(env.DB, update.update_id);
  }
}

/** Referral arg of a /start payload (incl. /start@BotName), or null. */
function referralArg(text: string | undefined): string | null {
  if (!text) return null;
  const parts = text.trim().split(/\s+/);
  const head = (parts[0] ?? '').slice(1).split('@')[0] ?? '';
  if (head.toLowerCase() !== 'start') return null;
  const arg = parts[1] ?? '';
  if (!arg.startsWith(REFERRAL_CODE_PREFIX)) return null;
  return arg.slice(REFERRAL_CODE_PREFIX.length) || null;
}

/** True when a message/caption text is a /start command (any @BotName form). */
function isStartCommand(text: string | undefined): boolean {
  if (!text) return false;
  const head = (text.trim().split(/\s+/)[0] ?? '').slice(1).split('@')[0] ?? '';
  return head.toLowerCase() === 'start';
}
