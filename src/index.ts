import type { Env } from './types';
import { handleHealth } from './routes/health';
import { handleWebhook } from './routes/webhook';
import { text } from './lib/http';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth(env);
    }

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      return handleWebhook(request, env);
    }

    return text('telbotv2 — see /health', 404);
  },
} satisfies ExportedHandler<Env>;
