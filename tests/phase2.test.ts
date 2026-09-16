/**
 * Phase 2 loop, replayed on the shared harness after Phase 3:
 * registration, menu, buy-start, name capture (now advancing to a real
 * volume step), hostile payloads, replay suppression, back/cancel, account.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER,
  callbackUpdate,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdate,
} from './helpers.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = freshDb();
const env = {
  DB: makeD1Shim(sqlite),
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown) => processTelegramUpdate(update, env);

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

const sendCalls = () => stub.sendCalls();

test('dispatcher ignores non-update payloads entirely', async () => {
  await dispatch({ not_an_update: true });
  assert.equal(stub.sent.length, 0);
});

test('phase2 loop: start → buy → name → volume step → replay → back', async () => {
  // /start registers + presents the main menu (5 sections in P2-P6; P7
  // added wallet + invite; Phase 10 added the language selector, Phase 11 the
  // connection guide, and the support split (🆘 direct + 🎫 ticket) → 10 buttons).
  // Phase 8A: it is a REAL Reply Keyboard.
  // Phase 15: a brand-new user's FIRST-ever /start additionally receives the
  // one-time free-test offer as a SEPARATE bubble (menu bubble stays #0).
  stub.reset();
  await dispatch(messageUpdate('/start', 11));
  const startBubbles = sendCalls();
  assert.equal(startBubbles.length, 2);
  const kb = startBubbles[0]?.payload['reply_markup'] as {
    keyboard: { text: string }[][];
    resize_keyboard?: boolean;
  };
  assert.equal(kb.keyboard.flat().length, 10);
  assert.equal(kb.resize_keyboard, true);
  assert.ok(
    String(startBubbles[1]?.text).includes('🎁'),
    'first-ever /start carries the free-test offer bubble',
  );
  const customerCount = () =>
    (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  assert.equal(customerCount(), 1);

  // repeated /start: idempotent
  await dispatch(messageUpdate('/start', 12));
  assert.equal(customerCount(), 1);

  // menu:buy → WAITING_CONFIG_NAME with a back button
  stub.reset();
  await dispatch(callbackUpdate('menu:buy', 13));
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');
  const prompt = sendCalls().find((s) => String(s.text).includes('🛒'));
  assert.ok(prompt, 'buy intro sent');

  // rejected hostile/unknown callbacks (state untouched)
  await dispatch(callbackUpdate('act:rmi_rf_root', 14));
  await dispatch(callbackUpdate('menu:buy\x00', 15));
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');

  // whitespace name → rejected, still waiting
  stub.reset();
  await dispatch(messageUpdate('   ', 16));
  assert.equal(currentSession()?.state, 'WAITING_CONFIG_NAME');
  assert.ok(String(sendCalls()[0]?.text).includes('نامعتبر'));

  // valid name → saved into draft AND the real volume step appears (Phase 3)
  stub.reset();
  await dispatch(messageUpdate('  northvalley7  ', 17));
  const session = currentSession();
  assert.equal(session?.state, 'WAITING_VOLUME');
  assert.equal(JSON.parse(String(session?.data)).config_name, 'northvalley7');
  assert.ok(String(sendCalls()[0]?.text).includes('northvalley7'));
  const volumeKb = sendCalls()[1]?.payload['reply_markup'] as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.ok(
    volumeKb.inline_keyboard.flat().some((b) => b.callback_data === 'vol:10'),
    'volume preset button appears',
  );

  // garbage text on the volume step: helpful rejection, state preserved
  stub.reset();
  await dispatch(messageUpdate('hello?', 18));
  const kept = currentSession();
  assert.equal(kept?.state, 'WAITING_VOLUME');
  assert.ok(String(sendCalls()[0]?.text).includes('صحیح'));

  // webhook replay of update 17: zero new API calls
  stub.reset();
  await dispatch(messageUpdate('  northvalley7  ', 17));
  assert.equal(stub.sent.length, 0, 'replay suppressed');

  // back-to-menu aborts the draft; order tables untouched
  stub.reset();
  await dispatch(callbackUpdate('act:back_menu', 19));
  assert.equal(currentSession(), null);
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n,
    0,
  );

  // account works for the registered customer. Phase 8A: the unified menu
  // action SENDS the card even for a legacy inline `menu:account` tap.
  stub.reset();
  await dispatch(callbackUpdate('menu:account', 20));
  const account = sendCalls().find((s) => String(s.text).includes('👤 اطلاعات حساب'));
  assert.ok(account && String(account.payload['text']).includes('ali_dev'));
});
