/**
 * Config-name handling (approved Phase 7 addition): strict English display
 * names (>=6 chars, no word-count minimum), the 🎲 auto-pick button, crypto
 * name generation, the panel-safe observation shape (kept SEPARATE: display
 * names never reach the panel), and the name-rejection notice + safe admin
 * retry — fully offline behind the fetch stub (real network never touched).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  USER,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  mediaUpdate,
  messageUpdateAs,
  type PanelRequest,
} from './helpers.ts';
import {
  panelSafeName,
  randomConfigName,
  validateConfigName,
} from '../src/lib/configName.ts';

// ————————————————————————— pure validation + generation —————————————————————————

test('validateConfigName: English >=6-char matrix (no word-count minimum)', () => {
  assert.equal(validateConfigName('Silver'), 'Silver'); // regression: the 6-letter single word
  assert.equal(validateConfigName('Aref sp'), 'Aref sp'); // regression: two short words, English, >=6 total
  assert.equal(validateConfigName('Silent Falcon'), 'Silent Falcon'); // old rule rejected 2 words
  assert.equal(validateConfigName('Network'), 'Network'); // old rule rejected 1 word
  assert.equal(validateConfigName('Silver Falcon Network'), 'Silver Falcon Network');
  assert.equal(validateConfigName('  north valley signal  '), 'north valley signal');
  assert.equal(validateConfigName('aBc DeF gHi'), 'aBc DeF gHi'); // case is free
  assert.equal(validateConfigName('one two three four five'), 'one two three four five'); // any word count
  // word cap (20) x 3 + single spaces — a 62-char name, safely inside the 64 bound:
  const wide = `${'a'.repeat(20)} ${'b'.repeat(20)} ${'c'.repeat(20)}`;
  assert.equal(validateConfigName(wide), wide);

  assert.equal(validateConfigName('Silve'), null, 'five chars rejected');
  assert.equal(validateConfigName('abc'), null, 'three chars rejected');
  assert.equal(validateConfigName('تست عالی'), null, 'Persian rejected');
  assert.equal(validateConfigName('_alpha bravo'), null, 'symbol not a letter');
  assert.equal(validateConfigName('alpha بتا gamma'), null, 'mixed script rejected');
  assert.equal(validateConfigName('   '), null, 'blank rejected');
  assert.equal(validateConfigName('/etc passwd alpha'), null, 'leading slash rejected');
  assert.equal(validateConfigName('Aref  sp'), null, 'double space = empty word');
  assert.equal(validateConfigName('Aref\tsp'), null, 'tab is not a normal space');
  assert.equal(validateConfigName('Alpha Bravo ch\u0001arlie'), null, 'control char rejected');
  assert.equal(validateConfigName(`short ${'b'.repeat(21)}`), null, 'word > 20 chars');
  assert.equal(validateConfigName(`${'a'.repeat(13)} `.repeat(4) + 'a'.repeat(13)), null, '> 64 chars');
  assert.equal(validateConfigName('123 456 789'), null, 'digits are not words');
  assert.equal(validateConfigName('test'), null, 'regression: 4 chars < 6');
  assert.equal(validateConfigName('test1'), null, 'regression: too short + digit');
  assert.equal(validateConfigName('test13'), null, 'regression: digits not allowed');
});

test('panelSafeName: observed panel shape (kept separate from display rules)', () => {
  // The manual observation that motivated the conservative envelope:
  assert.equal(panelSafeName('test'), false, 'observed rejected on the panel');
  assert.equal(panelSafeName('test1'), false, 'observed rejected on the panel');
  assert.equal(panelSafeName('test13'), true, 'observed accepted on the panel');
  // Real provisioned usernames always satisfy it too:
  assert.equal(panelSafeName('pg0001m2d3g6fdhvqpjp2xfc0r0jdg'), true);
  // Display names are a DIFFERENT axis — the panel never sees them:
  assert.equal(panelSafeName('Silver Falcon Network'), false);
  assert.equal(panelSafeName('AB1234'), false, 'uppercase not in the proven set');
  assert.equal(panelSafeName('abcdef!'), false, 'symbols not in the proven set');
  assert.equal(panelSafeName('x'.repeat(31)), false, 'beyond the client guard');
});

test('randomConfigName: 1000 names — exactly 3 clean English words, all valid', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const name = randomConfigName();
    assert.equal(validateConfigName(name), name, `must pass strict validation: ${name}`);
    const words = name.split(' ');
    assert.equal(words.length, 3, `exactly 3 words: ${name}`);
    for (const w of words) {
      assert.match(w, /^[A-Z][a-z]+$/, `capitalized letters only: ${w}`);
      assert.ok(w.length >= 4 && w.length <= 12, `natural word length: ${w}`);
      assert.match(w, /^[A-Za-z]{4,12}$/);
    }
    assert.ok(name.length <= 40, `well under the 64 cap: ${name.length}`);
    assert.equal(/[0-9]/.test(name), false, 'no digits — reads like words, not a username');
    const lower = name.toLowerCase();
    for (const banned of ['sex', 'ass', 'damn', 'hell', 'fuck', 'shit', 'tit', 'nazi', 'drug', 'kill', 'dead', 'bomb', 'porn']) {
      assert.equal(lower.includes(banned), false, `banned substring ${banned} in ${name}`);
    }
    seen.add(name);
  }
  assert.ok(seen.size >= 950, 'crypto picks must collide rarely (saw ' + String(seen.size) + ' unique)');
});

// ————————————————————————— e2e: prompt, button, auto-pick, forgery gates —————————————————————————

const PANEL_KEY = 'PG-TEST-KEY-42';
const PANEL_BASE = 'https://panel.test';
const users = new Map<string, { id: string; username: string }>();
let panelSeq = 500;
const scenario = {
  createError: null as { status: number; body: Record<string, string> } | null,
};

function panelRespond(request: PanelRequest): Response {
  if (request.method === 'GET' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    return user
      ? Response.json({ data: { ...user, status: 'active', subscription_url: `/sub/${username}/LINK` } })
      : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if (request.method === 'POST' && request.path === '/api/user') {
    if (scenario.createError) {
      return Response.json(scenario.createError.body, { status: scenario.createError.status });
    }
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    const record = { id: String(panelSeq++), username };
    users.set(username, record);
    return Response.json({ data: { ...record, status: 'active', subscription_url: `/sub/${username}/LINK` } });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: PANEL_KEY,
  PASARGUARD_PANEL_URL: PANEL_BASE,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};

let counter = 60000;
const nextId = () => ++counter;

const textsTo = (chatId: number) =>
  stub.sent
    .filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId)
    .map((s) => String(s.text));
const buttonsOf = (index = 0) => {
  const s = stub.sendCalls()[index];
  const kb = s?.payload['reply_markup'] as
    | { inline_keyboard: { callback_data: string }[][] }
    | undefined;
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
};
// Phase 8A: the config-name step speaks Reply Keyboard — text buttons.
const replyRowsOf = (index = 0) => {
  const s = stub.sendCalls()[index];
  const kb = s?.payload['reply_markup'] as
    | { keyboard: { text: string; style?: string }[][] }
    | undefined;
  return kb?.keyboard ?? [];
};
function sessionRow(tgUserId: number): { state: string; data: Record<string, unknown> } {
  const row = sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgUserId)) as { state: string; data: string } | undefined;
  return row ? { state: row.state, data: JSON.parse(row.data) } : { state: 'IDLE', data: {} };
}
function customerId(tgUserId: number): number {
  return Number(
    sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(tgUserId))['id'],
  );
}

async function buyToConfigNameStep(user: typeof USER): Promise<void> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
}

test('welcome greeting uses درود, never سلام', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  const all = textsTo(USER.id).join('\n');
  assert.ok(all.includes('درود'), `expected درود in: ${all}`);
  assert.equal(all.includes('سلام'), false, 'no سلام left in bot text');
});

test('name step: prompt + 🎲 انتخاب خودکار directly below the message', async () => {
  const ALICE = { ...USER, id: 610000001, username: 'alice_cfg' };
  stub.reset();
  await buyToConfigNameStep(ALICE);
  assert.equal(sessionRow(ALICE.id).state, 'WAITING_CONFIG_NAME');
  const intro = textsTo(ALICE.id).at(-1) ?? ''; // buyIntro carries the auto-pick keyboard
  assert.ok(intro.includes('نام'), `intro: ${intro}`);
  const kb = replyRowsOf(stub.sendCalls().length - 1);
  assert.equal(kb[0]?.[0]?.text, '🎲 انتخاب خودکار', 'auto button sits on the FIRST row');
  assert.equal(kb[1]?.[0]?.text, '🔙 بازگشت به منو');

  // re-entering the buy flow mid-name → the exact requested prompt
  stub.reset();
  await dispatch(callbackUpdateAs('menu:buy', nextId(), ALICE));
  const prompt = textsTo(ALICE.id).at(-1) ?? '';
  assert.equal(
    prompt,
    'زیبا لطفا یه نام انگلیسی حداقل ۶ حرفی انتخاب کن یا اگر میخوای من برات رندوم انتخاب کنم',
  );
  const rows = replyRowsOf(stub.sendCalls().length - 1);
  assert.ok(rows.flat().some((b) => b.text === '🎲 انتخاب خودکار'));
});

test('typed names: valid English (>=6 chars) continues; invalid refuses without state loss', async () => {
  const BOB = { ...USER, id: 610000002, username: 'bob_cfg' };
  await buyToConfigNameStep(BOB);

  // refusals keep the customer in WAITING_CONFIG_NAME with the button alive
  for (const bad of ['  ', 'تست فارسی', 'Silve', 'Aref  sp', 'al/pha bravo', 'a'.repeat(70)]) {
    stub.reset();
    await dispatch(messageUpdateAs(BOB, bad, nextId()));
    assert.equal(sessionRow(BOB.id).state, 'WAITING_CONFIG_NAME', `state kept for "${bad}"`);
    assert.ok(textsTo(BOB.id).some((t) => t.includes('نامعتبر')), `invalid feedback for "${bad}"`);
  }
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?1').get(customerId(BOB.id))['n'],
    0,
    'no order rows from refused names',
  );

  // the bug-fix inputs now continue: a 6-letter single word and a short two-word name
  await dispatch(messageUpdateAs(BOB, '  Silver  ', nextId()));
  const silver = sessionRow(BOB.id);
  assert.equal(silver.state, 'WAITING_VOLUME');
  assert.equal(silver.data['config_name'], 'Silver');
  await dispatch(callbackUpdateAs('step:back', nextId(), BOB, BOB.id));
  assert.equal(sessionRow(BOB.id).state, 'WAITING_CONFIG_NAME');
  await dispatch(messageUpdateAs(BOB, 'Aref sp', nextId()));
  const s = sessionRow(BOB.id);
  assert.equal(s.state, 'WAITING_VOLUME');
  assert.equal(s.data['config_name'], 'Aref sp');
});

test('cfg:auto end-to-end: advances with a generated 3-word name', async () => {
  const CYD = { ...USER, id: 610000003, username: 'cyd_cfg' };
  await buyToConfigNameStep(CYD);
  stub.reset();
  await dispatch(callbackUpdateAs('cfg:auto', nextId(), CYD));
  const s = sessionRow(CYD.id);
  assert.equal(s.state, 'WAITING_VOLUME');
  const name = String(s.data['config_name']);
  assert.match(name, /^[A-Z][a-z]{3,11} [A-Z][a-z]{3,11} [A-Z][a-z]{3,11}$/);
  assert.equal(validateConfigName(name), name);
  assert.ok(textsTo(CYD.id).some((t) => t.includes(name)), 'the saved name is echoed back');

  // step:back returns to the name step WITH the auto button still present
  stub.reset();
  await dispatch(callbackUpdateAs('step:back', nextId(), CYD, CYD.id));
  assert.equal(sessionRow(CYD.id).state, 'WAITING_CONFIG_NAME');
  assert.deepEqual(replyRowsOf(stub.sendCalls().length - 1)[0]?.[0]?.text, '🎲 انتخاب خودکار');
});

test('cfg:auto is inert out of state, on replay, and forged for strangers', async () => {
  // from IDLE: nothing at all
  const DAVE = { ...USER, id: 610000004, username: 'dave_idle' };
  await dispatch(messageUpdateAs(DAVE, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('cfg:auto', nextId(), DAVE));
  assert.equal(sessionRow(DAVE.id).state, 'IDLE');
  assert.equal(textsTo(DAVE.id).length, 0, 'no state-change chatter from IDLE');
  assert.equal(
    stub.sent.some((x) => x.method === 'answerCallbackQuery'),
    true,
    'neutral toast only',
  );

  // mid-volume: the name is ALREADY chosen — a stale button must not overwrite it
  await buyToConfigNameStep(DAVE);
  await dispatch(messageUpdateAs(DAVE, 'Quiet River Beacon', nextId()));
  assert.equal(sessionRow(DAVE.id).state, 'WAITING_VOLUME');
  stub.reset();
  await dispatch(callbackUpdateAs('cfg:auto', nextId(), DAVE));
  const s = sessionRow(DAVE.id);
  assert.equal(s.state, 'WAITING_VOLUME', 'stale tap is inert');
  assert.equal(s.data['config_name'], 'Quiet River Beacon', 'chosen name untouched');
  assert.equal(textsTo(DAVE.id).length, 0);

  // immediate replay inside the name step: first tap wins, second can never double-write
  const EVA = { ...USER, id: 610000005, username: 'eva_cfg' };
  await buyToConfigNameStep(EVA);
  await dispatch(callbackUpdateAs('cfg:auto', nextId(), EVA));
  const earned = sessionRow(EVA.id).data['config_name'];
  await dispatch(callbackUpdateAs('cfg:auto', nextId(), EVA));
  assert.equal(sessionRow(EVA.id).state, 'WAITING_VOLUME');
  assert.equal(sessionRow(EVA.id).data['config_name'], earned, 'replay cannot re-roll');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM conversation_states s JOIN customers c ON c.id = s.customer_id WHERE c.telegram_user_id = ?1').get(String(EVA.id))['n'],
    1,
    'single session row',
  );
});

test('existing purchase flow intact after strict names (typed 3-word → … → confirmed order)', async () => {
  const FRED = { ...USER, id: 610000006, username: 'fred_cfg' };
  await buyToConfigNameStep(FRED);
  await dispatch(messageUpdateAs(FRED, 'Golden Shadow Server', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), FRED));
  await dispatch(callbackUpdateAs('dur:30', nextId(), FRED));
  await dispatch(callbackUpdateAs('dev:3', nextId(), FRED));
  assert.equal(sessionRow(FRED.id).state, 'WAITING_ORDER_CONFIRMATION');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), FRED));
  const draft = sessionRow(FRED.id);
  assert.equal(draft.state, 'WAITING_PAYMENT_RECEIPT');
  const order = sqlite
    .prepare('SELECT * FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT 1')
    .get(customerId(FRED.id)) as Record<string, unknown>;
  assert.equal(order['state'], 'pending_payment');
  const snapshot = JSON.parse(String(order['selections'])) as Record<string, unknown>;
  assert.equal(snapshot['config_name'], 'Golden Shadow Server');
});

// ————————————————————————— panel rejection + safe retry —————————————————————————

async function purchaseToAwaitingReview(user: typeof USER): Promise<string> {
  await buyToConfigNameStep(user);
  await dispatch(messageUpdateAs(user, 'Crimson Horizon Cloud', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  await dispatch(callbackUpdateAs('dev:3', nextId(), user));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'CFG_RECEIPT' }, user));
  const row = sqlite
    .prepare('SELECT id FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT 1')
    .get(customerId(user.id)) as { id: string };
  return row.id;
}

test('panel rejects the name after local validation → honest notice, order & payment intact', async () => {
  const GINA = { ...USER, id: 610000007, username: 'gina_cfg' };
  users.clear();
  const orderId = await purchaseToAwaitingReview(GINA);
  scenario.createError = { status: 400, body: { detail: 'invalid username' } };
  stub.reset();
  stub.panel.reset();

  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  const order = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(orderId) as {
    state: string;
    failure_reason: string | null;
    provision_attempts: number;
  };
  assert.equal(order.state, 'failed', 'nothing lost: durable failed row');
  assert.match(String(order.failure_reason ?? ''), /invalid username/);
  assert.equal(order.provision_attempts, 1);

  const ginaTexts = textsTo(GINA.id).join('\n');
  assert.ok(ginaTexts.includes('نپذیرفت'), `friendly name-rejection copy expected: ${ginaTexts}`);
  assert.ok(ginaTexts.includes('محفوظ'), 'customer told the payment is safe');

  // zero duplicate side effects
  assert.equal(Number(stub.panel.calls.filter((c) => c.method === 'POST').length), 1, 'one create attempt');
  assert.equal(users.size, 0, 'no panel user exists');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM wallet_entries WHERE customer_id = ?1").get(customerId(GINA.id))['n'],
    0,
    'no wallet touch',
  );
  const orderRows = sqlite.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?1').get(customerId(GINA.id))['n'];
  assert.equal(orderRows, 1, 'never a second order row');
});

test('retry after the name rejection: succeeds once, no duplicates anywhere', async () => {
  const GINA = { ...USER, id: 610000007, username: 'gina_cfg' };
  const orderId = String(
    sqlite.prepare('SELECT id FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT 1').get(customerId(GINA.id))['id'],
  );
  scenario.createError = null;
  stub.reset();
  stub.panel.reset();

  await dispatch(callbackUpdateAs(`adm:rt:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  const order = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(orderId) as {
    state: string;
    provision_attempts: number;
    pasarguard_username: string | null;
  };
  assert.equal(order.state, 'completed');
  assert.equal(order.provision_attempts, 2, 'attempts tracked, not doubled');
  assert.equal(users.size, 1, 'exactly ONE panel user for the whole saga');
  assert.equal(stub.panel.calls.filter((c) => c.method === 'POST').length, 1, 'one create on the retry');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM wallet_entries WHERE customer_id = ?1").get(customerId(GINA.id))['n'],
    0,
    'still zero wallet movement',
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?1').get(customerId(GINA.id))['n'],
    1,
    'still one order row',
  );
  const ginaLast = textsTo(GINA.id).at(-1) ?? '';
  assert.ok(ginaLast.includes('سرویس شما ساخته'), `ready notice expected: ${ginaLast}`);
});

test('non-name failure keeps the generic notice (classifier is copy-only)', async () => {
  const HANZ = { ...USER, id: 610000008, username: 'hanz_cfg' };
  users.clear();
  const orderId = await purchaseToAwaitingReview(HANZ);
  scenario.createError = { status: 500, body: { detail: 'panel meltdown' } };
  stub.reset();
  stub.panel.reset();

  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  const text = textsTo(HANZ.id).join('\n');
  assert.equal(text.includes('نپذیرفت'), false, 'generic 500 must not claim a name issue');
  // stem follows the Phase 13 tone pass (generic copy: «دارن پیگیری می‌کنن»);
  // the name-rejected variant never says «پیگیری».
  assert.ok(text.includes('پیگیری'), `generic failure copy expected: ${text}`);
  scenario.createError = null;
});
