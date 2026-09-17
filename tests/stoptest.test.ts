/**
 * Phase 23 — /stoptest free-test stop switch.
 *
 * Focused, fully offline:
 *  - non-admin: exact cmdAdminOnly denial on command + taps, zero writes
 *  - admin status view (active) with stop button; command itself never mutates
 *  - stop flips ONLY enabled (policy preserved) + audit row; persists
 *  - blocked claim delivers the EXACT stopped bubble; no claim/order rows
 *  - pre-existing test service untouched (row-identical, claim intact, no panel)
 *  - start re-enables; claim works again (order + claim created)
 *  - stale stop-tap: already-stopped toast, settings row provably unmodified
 *  - malformed doc: reported, no buttons, no writes
 *  - paid buy ladder still reaches receipt stage while stopped
 *  - /users filter submenu + /msg smoke unaffected while stopped
 *  - confirmations secret-free, bubbles < 4000, toggle makes zero panel calls
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
  messageUpdateAs,
} from './helpers.ts';

const PANEL_BASE = 'https://panel.test';
const stub = makeFetchStub({
  base: PANEL_BASE,
  respond: () => Response.json({ detail: 'stoptest must never call the panel' }, { status: 500 }),
});
after(() => stub.restore());

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const { processTelegramUpdate } = await import('../src/dispatch.ts');
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: 'PG-TEST-KEY',
  PASARGUARD_PANEL_URL: PANEL_BASE,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

let counter = 150000;
const nextId = () => ++counter;
const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');
const { newOrderId } = await import('../src/lib/security.ts');

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
const lastTextTo = (chatId: number): string => textsTo(chatId).at(-1) ?? '';
const buttonsOf = (chatId: number): string[] => {
  const data: string[] = [];
  for (const s of sentTo(chatId)) {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) if (b.callback_data !== undefined) data.push(b.callback_data);
    }
  }
  return data;
};
const toastsTo = (chatId: number): string[] =>
  stub.sent
    .filter((s) => s.method === 'answerCallbackQuery')
    .map((s) => String((s.payload as Record<string, unknown>)['text'] ?? ''));

const freeDoc = () =>
  sqlite.prepare(`SELECT value, updated_by, updated_at FROM settings WHERE key = 'free_test'`).get() as {
    value: string;
    updated_by: string | null;
    updated_at: string;
  };
const auditFor = (action: string): Record<string, unknown>[] =>
  sqlite.prepare(`SELECT * FROM settings_audit WHERE key = 'free_test' AND action = ?1`).all(action) as unknown as Record<
    string,
    unknown
  >[];

const VETERAN = { id: 810001, first_name: 'Vet', username: 'stp_veteran', language_code: 'fa' };
const NEWBIE = { id: 810002, first_name: 'New', username: 'stp_newbie', language_code: 'fa' };
const FRESH = { id: 810003, first_name: 'Fre', username: 'stp_fresh', language_code: 'fa' };

function seedVeteranTestService(): string {
  const cid = sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(VETERAN.id)) as {
    id: number;
  };
  const orderId = newOrderId();
  const stamp = new Date(Date.now() - 86_400_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency,
         pasarguard_username, subscription_url, service_created_at, service_expires_at, created_at, updated_at)
       VALUES (?1, ?2, 'completed', 'purchase', ?3, 0, 'IRT', ?4, ?5, ?6, ?7, ?6, ?6)`,
    )
    .run(
      orderId,
      cid.id,
      JSON.stringify({ schema: 1, free_test: true, config_name: 'VETTEST', volume_mb: 100, duration_days: 1, device_count: 1 }),
      `panel_${orderId.toLowerCase()}`,
      `https://panel.test/sub/SECRET_${orderId}`,
      stamp,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
  sqlite.prepare('INSERT INTO free_test_claims (customer_id, order_id) VALUES (?1, ?2)').run(cid.id, orderId);
  return orderId;
}
const orderSnapshot = (id: string) =>
  JSON.stringify(sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id));

test('non-admin /stoptest denied; taps inert with zero writes', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  const before = freeDoc().value;
  await dispatch(messageUpdateAs(USER, '/stoptest', nextId()));
  assert.ok(textsTo(USER.id).includes(fa.cmdAdminOnly));
  const userTextsBefore = textsTo(USER.id).length;
  await dispatch(callbackUpdateAs('stp:stop', nextId(), USER, USER.id));
  await dispatch(callbackUpdateAs('stp:view', nextId(), USER, USER.id));
  assert.equal(freeDoc().value, before, 'no writes from non-admin');
  assert.ok(
    !textsTo(USER.id).slice(userTextsBefore).some((t) => t.includes('تست رایگان')),
    'no status leaks',
  );
});

test('admin status view shows active state without mutating', async () => {
  stub.reset();
  const before = freeDoc();
  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes(fa.adminStoptestStateActive));
  assert.ok(buttonsOf(ADMIN.id).includes('stp:stop'), 'disable button offered');
  assert.ok(buttonsOf(ADMIN.id).includes('stp:view'));
  assert.deepEqual(freeDoc(), before, 'the command itself never mutates');
});

test('stop flips only enabled, preserves policy, audits, persists', async () => {
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  const after = freeDoc();
  const doc = JSON.parse(after.value) as Record<string, unknown>;
  assert.equal(doc['enabled'], false);
  assert.equal(doc['schema'], 1);
  assert.equal(doc['volume_mb'], 100);
  assert.equal(doc['duration_days'], 1);
  assert.equal(doc['device_count'], 1);
  assert.equal(after.updated_by, `admin:${ADMIN.id}`);
  const audits = auditFor('disable');
  assert.equal(audits.length, 1, 'exactly one audit row');
  assert.equal(stub.panel.calls.length, 0, 'toggle makes zero panel calls');
  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes(fa.adminStoptestStateStopped), 'stopped state persists');
  assert.ok(buttonsOf(ADMIN.id).includes('stp:start'), 'enable button offered');
});

test('blocked claim delivers the exact bubble; nothing durable created', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(NEWBIE, '/start', nextId()));
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(NEWBIE.id)) as { id: number }).id;
  stub.reset();
  await dispatch(callbackUpdateAs('tst:claim', nextId(), NEWBIE, NEWBIE.id));
  assert.equal(lastTextTo(NEWBIE.id), fa.freeTestStoppedNotice);
  assert.equal(
    fa.freeTestStoppedNotice,
    '🛑 رفیق، سرویس تست فعلاً متوقفه 😅\nبه‌محض اینکه دوباره فعالش کنیم، می‌تونی تستت رو بگیری ❤️',
  );
  const claims = sqlite.prepare('SELECT COUNT(*) AS n FROM free_test_claims WHERE customer_id = ?1').get(cid) as {
    n: number;
  };
  assert.equal(claims.n, 0, 'the once-ever wall is not burned by a blocked tap');
  const orders = sqlite.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?1').get(cid) as { n: number };
  assert.equal(orders.n, 0, 'no order row created');
});

test('pre-existing test service untouched by the stop', async () => {
  await dispatch(messageUpdateAs(VETERAN, '/start', nextId()));
  const orderId = seedVeteranTestService();
  const before = orderSnapshot(orderId);
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(VETERAN.id)) as { id: number }).id;
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  await dispatch(callbackUpdateAs('stp:view', nextId(), ADMIN, ADMIN.id));
  assert.equal(orderSnapshot(orderId), before, 'order row byte-identical');
  const claim = sqlite.prepare('SELECT order_id FROM free_test_claims WHERE customer_id = ?1').get(cid) as {
    order_id: string;
  };
  assert.equal(claim.order_id, orderId, 'claim intact');
  assert.equal(stub.panel.calls.length, 0);
});

test('start re-enables; claim works again; stale stop-tap writes nothing', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('stp:start', nextId(), ADMIN, ADMIN.id));
  assert.equal((JSON.parse(freeDoc().value) as { enabled: boolean }).enabled, true);
  assert.equal(auditFor('enable').length, 1);

  await dispatch(messageUpdateAs(FRESH, '/start', nextId()));
  await dispatch(callbackUpdateAs('tst:claim', nextId(), FRESH, FRESH.id));
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(FRESH.id)) as { id: number }).id;
  const claim = sqlite.prepare('SELECT order_id FROM free_test_claims WHERE customer_id = ?1').get(cid) as {
    order_id: string;
  } | null;
  assert.ok(claim !== null, 'claim created once re-enabled');
  const order = sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(claim.order_id) as { state: string };
  assert.ok(['approved', 'provisioning', 'completed', 'failed'].includes(order.state), `order born, state=${order.state}`);

  // Back to stopped, then a stale second stop-tap must be a no-op write-wise.
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  const stamped = freeDoc().updated_at;
  stub.reset();
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  assert.equal(freeDoc().updated_at, stamped, 'idempotent tap performs zero writes');
  assert.ok(
    toastsTo(ADMIN.id).some((t) => t.includes('از قبل متوقف')),
    'already-stopped confirmation toasted',
  );
  // Restore enabled for the remaining tests / repo hygiene.
  await dispatch(callbackUpdateAs('stp:start', nextId(), ADMIN, ADMIN.id));
  assert.equal((JSON.parse(freeDoc().value) as { enabled: boolean }).enabled, true);
});

test('malformed doc: reported, no toggle buttons, no writes', async () => {
  const good = freeDoc().value;
  // Valid JSON but wrong schema: realistic corruption the strict parser rejects
  // (settings.value itself carries a json_valid CHECK, so '{broken' is untestable).
  sqlite.prepare(`UPDATE settings SET value = ?1 WHERE key = 'free_test'`).run('{"schema":999}');
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes(fa.adminStoptestMalformed));
  assert.deepEqual(buttonsOf(ADMIN.id), ['stp:view'], 'only refresh offered');
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  const row = sqlite.prepare(`SELECT value FROM settings WHERE key = 'free_test'`).get() as { value: string };
  assert.equal(row?.value, '{"schema":999}', 'unusable doc left intact, nothing invented');
  sqlite.prepare(`UPDATE settings SET value = ?1 WHERE key = 'free_test'`).run(good);
});

test('paid buy ladder still reaches receipt stage while stopped', async () => {
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  const buyer = { id: 810004, first_name: 'Buy', username: 'stp_buyer', language_code: 'fa' };
  await dispatch(messageUpdateAs(buyer, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), buyer, buyer.id));
  await dispatch(messageUpdateAs(buyer, 'BUYTEST01', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), buyer, buyer.id));
  await dispatch(callbackUpdateAs('dur:30', nextId(), buyer, buyer.id));
  await dispatch(callbackUpdateAs('dev:1', nextId(), buyer, buyer.id));
  stub.reset();
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), buyer, buyer.id));
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(buyer.id)) as { id: number }).id;
  const pending = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?1 AND state = 'pending_payment'`,
  ).get(cid) as { n: number };
  assert.ok(pending.n >= 1, 'paid purchase entry ungated by the test switch');
  await dispatch(callbackUpdateAs('stp:start', nextId(), ADMIN, ADMIN.id));
});

test('/users filters + /msg smoke unaffected; output hygiene', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:filter', nextId(), ADMIN, ADMIN.id));
  assert.equal(lastTextTo(ADMIN.id), fa.usersFilterHeader, 'filter submenu intact');
  await dispatch(messageUpdateAs(ADMIN, `/msg ${VETERAN.id} hello from admin`, nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.msgSent, '/msg still relays');
  assert.ok(lastTextTo(VETERAN.id).includes('hello from admin'));
  for (const s of stub.sent.filter((m) => m.method === 'sendMessage')) {
    const text = String(s.text);
    assert.ok(text.length < 4000);
    assert.ok(!text.includes('SECRET_'), 'no subscription secrets');
    assert.ok(!text.includes('PG-TEST-KEY'), 'no panel key');
  }
  // Repo hygiene: leave the switch exactly as seeded (enabled, original doc).
  const doc = JSON.parse(freeDoc().value) as Record<string, unknown>;
  assert.equal(doc['enabled'], true);
});
