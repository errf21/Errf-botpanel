import type { Env, TelegramUpdate } from '../types.ts';
import { UpdateClaimUnavailable } from '../db/dedupe.ts';
import { json } from '../lib/http.ts';
import { timingSafeEqual } from '../lib/security.ts';
import { processTelegramUpdate } from '../dispatch.ts';

/**
 * POST /telegram/webhook
 *
 * Phase 2: same hard authentication gates as Phase 1 (503 fail-closed,
 * 401 bad token, 400 unparseable) — then the validated update is handed to
 * the dispatcher. Handler errors are contained: we still ACK 200 so Telegram
 * doesn't retry-hammer the worker.
 * Phase 5: the execution context lets post-ACK work (provisioning) keep
 * running via waitUntil while the webhook answers immediately.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
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

  // Admission failures return 503 for safe redelivery. Once admitted, existing
  // handler-error containment remains unchanged; do not reinterpret it as dedupe.
  try {
    await processTelegramUpdate(update, env, executionCtx
      ? { waitUntil: (promise) => executionCtx.waitUntil(promise) }
      : undefined);
  } catch(error) {
    if(error instanceof UpdateClaimUnavailable){
      const response=json({error:'update_claim_unavailable'},503);response.headers.set('retry-after','5');return response;
    }
    console.error(`webhook_dispatch_error update_id=${String(update.update_id)}`);
  }
  return json({ ok: true });
}
