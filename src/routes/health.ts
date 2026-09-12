import type { Env } from '../types';
import { json } from '../lib/http';

/**
 * GET /health
 * Reports worker liveness, D1 connectivity and which required
 * bindings are configured — without exposing any secret values.
 */
export async function handleHealth(env: Env): Promise<Response> {
  let d1: 'ok' | 'error' = 'error';
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    d1 = 'ok';
  } catch {
    // report status, never leak the underlying error
  }

  return json(
    {
      service: 'telbotv2',
      status: d1 === 'ok' ? 'healthy' : 'degraded',
      time: new Date().toISOString(),
      checks: {
        d1,
        telegram_token: Boolean(env.TELEGRAM_BOT_TOKEN),
        webhook_secret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
        pasarguard_key: Boolean(env.PASARGUARD_API_KEY),
      },
    },
    d1 === 'ok' ? 200 : 503,
  );
}
