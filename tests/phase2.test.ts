/**
 * End-to-end Phase 2 check: runs the REAL dispatcher + handlers + TelegramApi
 * against an in-memory SQLite D1 shim and a stubbed `fetch` (no network ever).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

const sent: Sent[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = String(input);
  const method = url.match(/\/bot[^/]+\/(\w+)$/)?.[1] ?? 'unknown';
  const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  sent.push({ method, payload });
  return Response.json({ ok: true, result: {} });
}) as typeof fetch;

function resetSent(): void {
  sent.length = 0;
}

const here = fileURLToPath(new URL('.', import.meta.url));
const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(`${here}../migrations/0001_init.sql`, 'utf8'));
sqlite.exec(readFileSync(`${here}../migrations/0002_phase2.sql`, 'utf8'));

interface ShimStatement {
  bind(...values: unknown[]): ShimStatement;
  run(): void;
  first<T extends object>(): T | null;
}

function makeD1Shim(db: DatabaseSync) {
  return {
    prepare(sql: string): ShimStatement {
      const stmt = db.prepare(sql);
      let values: unknown[] = [];
      const api: ShimStatement = {
        bind(...args: unknown[]) {
          values = args;
          return api;
        },
        run() {
          stmt.run(...values);
          values = [];
        },
        first<T extends object>() {
          const row = stmt.get(...values) as T | undefined;
          values = [];
          return row ?? null;
        },
      };
      return api;
    },
  };
}

const env = {
  DB: makeD1Shim(sqlite),
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  // unknown fields are ignored by the dispatcher
} as unknown as Parameters<typeof processTelegramUpdate>[1];

function dispatch(update: unknown): Promise<void> {
  return processTelegramUpdate(update, env);
}

const USER = {
  id: 987654321,
  first_name: 'Ali',
  username: 'ali_dev',
  language_code: 'fa',
};

const messageUpdate = (text: string, updateId: number) => ({
  update_id: updateId,
  message: {
    message_id: 100 + updateId,
    from: USER,
    chat: { id: USER.id, type: 'private' },
    text,
  },
});

const callbackUpdate = (data: unknown, updateId: number) => ({
  update_id: updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: USER,
    data,
    message: { message_id: 500, chat: { id: USER.id } },
  },
});

function currentSession(): { state: string; data: string } | null {
  const row = sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = '987654321'`,
    )
    .get() as { state: string; data: string } | undefined;
  return row ?? null;
}

const sendCalls = () => sent.filter((s) => s.method === 'sendMessage');

test('webhook secret stays validated by route, dispatcher requires update shape', async () => {
  await dispatch({ not_an_update: true }); // must not throw
  assert.equal(sent.length, 0);
});

test('phase2 full loop: register → menu → buy → name → volume → replay → cancel', async () => {
  // 1. /start registers and sends the 5-button main menu
  resetSent();
  await dispatch(messageUpdate('/start', 11));
  assert.equal(sendCalls().length, 1);
  assert.ok(String(sent[0]?.payload['text']).includes('سلام'));
  const kb = sent[0]?.payload['reply_markup'] as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.equal(kb.inline_keyboard.flat().length, 5);
  assert.deepEqual(
    [...new Set(kb.inline_keyboard.flat().map((b) => b.callback_data))].sort(),
    ['menu:account', 'menu:buy', 'menu:orders', 'menu:services', 'menu:support'],
  );
  const customerCount = () =>
    (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  assert.equal(customerCount(), 1);

  // 2. repeated /start: idempotent — still one customer
  await dispatch(messageUpdate('/start', 12));
  assert.equal(customerCount(), 1);

  // 3. menu:buy → WAITING_CONFIG_NAME + prompt carrying the back button
  resetSent();
  await dispatch(callbackUpdate('menu:buy', 13));
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');
  const prompt = sendCalls().find((s) => String(s.payload['text']).includes('🛒'));
  assert.ok(prompt, 'buy prompt sent');
  assert.equal(
    (prompt.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]?.[0]?.callback_data,
    'act:back_menu',
  );
  assert.ok(sent.some((s) => s.method === 'answerCallbackQuery'));

  // 4. hostile / unknown callback payloads rejected; state untouched
  resetSent();
  await dispatch(callbackUpdate('act:rmi_rf_root', 14)); // unknown, not on allowlist
  await dispatch(callbackUpdate('menu:buy\x00', 15)); // malformed
  for (const s of sent) {
    assert.ok(!(s.method === 'sendMessage' && String(s.payload['text']).includes('خرید سرویس')));
  }
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');

  // 5. empty/whitespace text: name step rejects, stays put
  resetSent();
  await dispatch(messageUpdate('   ', 16));
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');
  assert.ok(String(sendCalls()[0]?.payload['text']).includes('نامعتبر'));

  // 6. valid config name: trimmed, stored in draft JSON, advances to WAITING_VOLUME
  resetSent();
  await dispatch(messageUpdate('  vpn-main-01  ', 17));
  const session = currentSession();
  assert.equal(session?.state, 'WAITING_VOLUME');
  assert.equal(JSON.parse(String(session?.data)).config_name, 'vpn-main-01');
  assert.ok(String(sendCalls()[0]?.payload['text']).includes('vpn-main-01'));

  // 7. later text states: no handlers yet → hint, state/data preserved
  await dispatch(messageUpdate('hello?', 18));
  const kept = currentSession();
  assert.equal(kept?.state, 'WAITING_VOLUME');
  assert.equal(JSON.parse(String(kept?.data)).config_name, 'vpn-main-01');

  // 8. webhook replay of update 17: zero new API calls
  resetSent();
  await dispatch(messageUpdate('  vpn-main-01  ', 17));
  assert.equal(sent.length, 0, 'replay suppressed');

  // 9. back button → IDLE (row cleared) + menu delivered
  resetSent();
  await dispatch(callbackUpdate('act:back_menu', 19));
  assert.equal(currentSession(), null);
  assert.ok(sendCalls().some((s) => String(s.payload['text']).includes('منوی اصلی')));

  // 10. account reflects stored profile + idle status
  resetSent();
  await dispatch(callbackUpdate('menu:account', 20));
  const account = sent.find((s) => s.method === 'editMessageText');
  assert.ok(account && String(account.payload['text']).includes('ali_dev'));
  assert.equal(currentSession(), null);
});

after(() => {
  globalThis.fetch = realFetch;
});
