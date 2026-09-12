import type { Env, TelegramUpdate } from '../types';
import { json } from '../lib/http';
import { timingSafeEqual } from '../lib/security';

/**
 * POST /telegram/webhook
 *
 * Phase 1 scope only: authentication + safe acknowledgement.
 * Update dispatching (menu, purchase flow, …) lands in later phases;
 * a 200 response prevents Telegram retries from hammering the worker.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    // Fail closed: never accept updates while the secret is unconfigured.
    return json({ error: 'webhook_secret_not_configured' }, 503);
  }

  const token = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(token, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // Phase 2+: route update to the state machine here.
  console.log(`telegram update received: ${update.update_id}`);

  return json({ ok: true });
}
