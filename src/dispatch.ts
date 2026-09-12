import type { Env, TelegramUpdate, UpdateContext } from './types.ts';
import { TelegramApi } from './telegram/api.ts';
import { upsertCustomer } from './db/customers.ts';
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
  if ((await claimUpdate(env.DB, update.update_id)) !== 'fresh') return; // webhook replay

  try {
    const callback = update.callback_query;
    const message = update.message ?? update.edited_message;

    const actor = callback?.from ?? message?.from;
    if (!actor || !isValidTelegramUserId(actor.id)) return;

    const rawChat = callback?.message?.chat?.id ?? message?.chat?.id;
    const chatId = typeof rawChat === 'number' && Number.isSafeInteger(rawChat)
      ? rawChat
      : actor.id;

    const customerId = await upsertCustomer(env.DB, actor);
    const ctx: UpdateContext = {
      env,
      db: env.DB,
      api: new TelegramApi(env.TELEGRAM_BOT_TOKEN),
      actor,
      chatId,
      customerId,
      isAdmin: await resolveIsAdmin(env, env.DB, actor.id),
      waitUntil: options?.waitUntil,
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
    const name = error instanceof Error ? `${error.name}:${error.message}` : 'unknown';
    console.error(`update_dispatch_failed update_id=${update.update_id} error=${name.slice(0, 200)}`);
    // Swallow (caller still returns 200 to stop retry storms) but release the
    // dedupe claim so a re-delivered update can be retried instead of dropped.
    await releaseUpdate(env.DB, update.update_id);
  }
}
