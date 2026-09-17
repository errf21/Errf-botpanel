/**
 * Phase 22 — /users filter submenu.
 *
 * Focused, fully offline (snapshot/D1 only):
 *  - submenu renders 6 filters with live DISTINCT counts + back
 *  - all / active / paywait / review / failed / deleted membership + exclusion
 *  - DISTINCT customer behavior (multi-match user appears once)
 *  - pagination at 8/page with prev/next + back-to-filter
 *  - profile opened from a filtered list backs to that filtered list
 *  - admin authorization on filter entry + filtered lists (zero writes)
 *  - strict parser: old 4-part callbacks default to 'all', hostile rejected
 *  - zero PasarGuard calls, no secret leakage, bubbles < 4000 chars
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
  respond: () => Response.json({ detail: 'filter screens must never call the panel' }, { status: 500 }),
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

let counter = 120000;
const nextId = () => ++counter;
const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');
const { parseUsersCallback, isValidCallbackData } = await import('../src/lib/validate.ts');
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

function customerIdOf(tgId: number): number {
  const row = sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(tgId)) as {
    id: number;
  };
  return row.id;
}

function insertPurchase(opts: {
  customerId: number;
  name: string;
  expiresInDays?: number | null;
  deleted?: boolean;
  freeTest?: boolean;
}): string {
  const id = newOrderId();
  const created = new Date(Date.now() - 86_400_000).toISOString();
  const expires =
    opts.expiresInDays === null || opts.expiresInDays === undefined
      ? null
      : new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString();
  const selections = opts.freeTest === true
    ? JSON.stringify({ config_name: opts.name, volume_mb: 100, duration_days: 1, device_count: 1, free_test: true })
    : JSON.stringify({ config_name: opts.name, volume_gb: 10, duration_days: 30, device_count: 1 });
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency,
         pasarguard_username, subscription_url, service_created_at, service_expires_at,
         panel_deleted_at, panel_deleted_by, created_at, updated_at)
       VALUES (?1, ?2, 'completed', 'purchase', ?3, 100000, 'IRT', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    )
    .run(
      id,
      opts.customerId,
      selections,
      `panel_${id.toLowerCase()}`,
      `https://panel.test/sub/SECRET_${id}`,
      created,
      expires,
      opts.deleted === true ? created : null,
      opts.deleted === true ? `admin:${ADMIN.id}` : null,
      created,
    );
  return id;
}

function insertPlainOrder(customerId: number, state: string, failedDeleted = false): string {
  const id = newOrderId();
  const stamp = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency,
         panel_deleted_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'purchase', ?4, 100000, 'IRT', ?5, ?6, ?6)`,
    )
    .run(
      id,
      customerId,
      state,
      JSON.stringify({ config_name: 'PENDING01', volume_gb: 10, duration_days: 30, device_count: 1 }),
      failedDeleted ? stamp : null,
      stamp,
    );
  return id;
}

const U = {
  active: { id: 791001, first_name: 'Act', username: 'flt_active', language_code: 'fa' },
  expired: { id: 791002, first_name: 'Exp', username: 'flt_expired', language_code: 'fa' },
  deleted: { id: 791003, first_name: 'Del', username: 'flt_deleted', language_code: 'fa' },
  free: { id: 791004, first_name: 'Free', username: 'flt_free', language_code: 'fa' },
  pay: { id: 791005, first_name: 'Pay', username: 'flt_pay', language_code: 'fa' },
  review: { id: 791006, first_name: 'Rev', username: 'flt_review', language_code: 'fa' },
  failed: { id: 791007, first_name: 'Fail', username: 'flt_failed', language_code: 'fa' },
  failedDeleted: { id: 791008, first_name: 'FailDel', username: 'flt_faildel', language_code: 'fa' },
  double: { id: 791009, first_name: 'Dbl', username: 'flt_double', language_code: 'fa' },
  multi: { id: 791010, first_name: 'Mul', username: 'flt_multi', language_code: 'fa' },
};

async function seed(): Promise<void> {
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  for (const u of Object.values(U)) await dispatch(messageUpdateAs(u, '/start', nextId()));
  for (let i = 0; i < 9; i++) {
    const fan = { id: 792000 + i, first_name: `Fan${i}`, username: `flt_fan_${i}`, language_code: 'fa' };
    await dispatch(messageUpdateAs(fan, '/start', nextId()));
    insertPlainOrder(customerIdOf(fan.id), 'pending_payment');
  }
  insertPurchase({ customerId: customerIdOf(U.active.id), name: 'ERRF_ACT', expiresInDays: 20 });
  insertPurchase({ customerId: customerIdOf(U.expired.id), name: 'ERRF_OLD', expiresInDays: -5 });
  insertPurchase({ customerId: customerIdOf(U.deleted.id), name: 'ERRF_GONE', expiresInDays: 20, deleted: true });
  insertPurchase({ customerId: customerIdOf(U.free.id), name: 'ERRF_TEST', expiresInDays: 1, freeTest: true });
  insertPlainOrder(customerIdOf(U.pay.id), 'pending_payment');
  insertPlainOrder(customerIdOf(U.review.id), 'awaiting_review');
  insertPlainOrder(customerIdOf(U.failed.id), 'failed');
  insertPlainOrder(customerIdOf(U.failedDeleted.id), 'failed', true);
  insertPlainOrder(customerIdOf(U.double.id), 'pending_payment');
  insertPlainOrder(customerIdOf(U.double.id), 'pending_payment');
  insertPurchase({ customerId: customerIdOf(U.multi.id), name: 'ERRF_MUL', expiresInDays: 20 });
  insertPlainOrder(customerIdOf(U.multi.id), 'pending_payment');
}

await seed();

test('filter submenu renders six counted filters + back', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:filter', nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.equal(text, fa.usersFilterHeader);
  const buttons = buttonsOf(ADMIN.id);
  // paywait: pay + double + multi + 9 fans = 12; active: active + multi = 2.
  // NOTE: 'all' deliberately keeps the legacy unsuffixed form.
  assert.ok(buttons.includes('usr:list:det:0'));
  assert.ok(buttons.includes('usr:list:det:0:active'));
  assert.ok(buttons.includes('usr:list:det:0:paywait'));
  assert.ok(buttons.includes('usr:list:det:0:review'));
  assert.ok(buttons.includes('usr:list:det:0:failed'));
  assert.ok(buttons.includes('usr:list:det:0:deleted'));
  assert.ok(buttons.includes('usr:menu'), 'back to dashboard');
  assert.equal(buttons.length, 7, 'six filters + one back, nothing else');
});

test('submenu labels carry live DISTINCT counts', async () => {
  const labels: string[] = [];
  for (const s of sentTo(ADMIN.id)) {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { text?: string }[][] } | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) if (b.text !== undefined) labels.push(b.text);
    }
  }
  assert.ok(labels.includes(fa.usersFilterActive('2')), `active count 2, got: ${labels.join(' | ')}`);
  assert.ok(labels.includes(fa.usersFilterPaywait('12')));
  assert.ok(labels.includes(fa.usersFilterReview('1')));
  assert.ok(labels.includes(fa.usersFilterFailed('1')));
  assert.ok(labels.includes(fa.usersFilterDeleted('1')));
});

test('active filter: members in, expired/deleted/test/payment-only out', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:list:det:0:active', nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes(fa.usersFilterLabel('active')));
  assert.ok(text.includes('@flt_active'));
  assert.ok(text.includes('@flt_multi'));
  for (const excluded of ['@flt_expired', '@flt_deleted', '@flt_free', '@flt_pay', '@flt_review']) {
    assert.ok(!text.includes(excluded), `${excluded} must not match active`);
  }
  const buttons = buttonsOf(ADMIN.id);
  assert.ok(buttons.includes('usr:menu') === false, 'filtered list backs to submenu, not dashboard');
  assert.ok(buttons.some((b) => b === 'usr:filter'), 'back to filter submenu');
});

test('paywait/review/failed/deleted membership + exclusions', async () => {
  stub.reset();
  // paywait spans 2 pages (12 users, newest-first); collect both.
  await dispatch(callbackUpdateAs('usr:list:det:0:paywait', nextId(), ADMIN, ADMIN.id));
  const payPage0 = lastTextTo(ADMIN.id);
  await dispatch(callbackUpdateAs('usr:list:det:1:paywait', nextId(), ADMIN, ADMIN.id));
  const payText = `${payPage0}\n${lastTextTo(ADMIN.id)}`;
  assert.ok(payText.includes('@flt_pay') && payText.includes('@flt_multi') && payText.includes('@flt_double'));
  assert.ok(!payText.includes('@flt_review'), 'awaiting_review is not awaiting-payment');

  await dispatch(callbackUpdateAs('usr:list:det:0:review', nextId(), ADMIN, ADMIN.id));
  const revText = lastTextTo(ADMIN.id);
  assert.ok(revText.includes('@flt_review'));
  assert.ok(!revText.includes('@flt_pay'));

  await dispatch(callbackUpdateAs('usr:list:det:0:failed', nextId(), ADMIN, ADMIN.id));
  const failText = lastTextTo(ADMIN.id);
  assert.ok(failText.includes('@flt_failed'));
  assert.ok(!failText.includes('@flt_faildel'), 'panel-deleted failures follow listOrdersFailed');

  await dispatch(callbackUpdateAs('usr:list:det:0:deleted', nextId(), ADMIN, ADMIN.id));
  const delText = lastTextTo(ADMIN.id);
  assert.ok(delText.includes('@flt_deleted'));
  assert.ok(!delText.includes('@flt_active'));
});

test('multi-match customer appears exactly once per filtered list', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:list:det:0:paywait', nextId(), ADMIN, ADMIN.id));
  await dispatch(callbackUpdateAs('usr:list:det:1:paywait', nextId(), ADMIN, ADMIN.id));
  const hits = buttonsOf(ADMIN.id).filter((b) => b.startsWith(`usr:det:${U.double.id}:`));
  assert.equal(hits.length, 1, 'one button per customer even with two matching orders');
});

test('filtered pagination: 8/page with prev/next, clamp on overflow', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:list:det:0:paywait', nextId(), ADMIN, ADMIN.id));
  const rows0 = lastTextTo(ADMIN.id).split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(rows0.length, 8, 'page 0 capped at 8');
  assert.ok(buttonsOf(ADMIN.id).includes('usr:list:det:1:paywait'), 'has next');

  await dispatch(callbackUpdateAs('usr:list:det:1:paywait', nextId(), ADMIN, ADMIN.id));
  const rows1 = lastTextTo(ADMIN.id).split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(rows1.length, 4, '12 total → 8 + 4');
  assert.ok(buttonsOf(ADMIN.id).includes('usr:list:det:0:paywait'), 'has prev');
  assert.ok(buttonsOf(ADMIN.id).includes('usr:filter'), 'back stays on submenu');

  await dispatch(callbackUpdateAs('usr:list:det:99:failed', nextId(), ADMIN, ADMIN.id));
  assert.ok(lastTextTo(ADMIN.id).includes('@flt_failed'), 'overflow clamps to the last page');
});

test('profile from a filtered list backs to that filtered list', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs(`usr:det:${U.pay.id}:det:0:paywait`, nextId(), ADMIN, ADMIN.id));
  const profile = lastTextTo(ADMIN.id);
  assert.ok(profile.includes(String(U.pay.id)));
  assert.ok(
    buttonsOf(ADMIN.id).includes('usr:list:det:0:paywait'),
    'profile back returns to the filtered list page',
  );
});

test('unfiltered list + profile back behavior unchanged', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('usr:list:det:0', nextId(), ADMIN, ADMIN.id));
  assert.ok(!lastTextTo(ADMIN.id).includes('🟢 سرویس فعال'), 'no filter label on the all-list');
  assert.ok(buttonsOf(ADMIN.id).includes('usr:menu'), 'all-list still backs to dashboard');
  await dispatch(callbackUpdateAs(`usr:det:${U.pay.id}:det:0`, nextId(), ADMIN, ADMIN.id));
  assert.ok(buttonsOf(ADMIN.id).includes('usr:list:det:0'), 'profile still backs to the plain list');
});

test('non-admin filter entry + filtered lists denied with zero writes', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  const usersBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  const sendsBefore = stub.sent.length;
  await dispatch(callbackUpdateAs('usr:filter', nextId(), USER, USER.id));
  await dispatch(callbackUpdateAs('usr:list:det:0:paywait', nextId(), USER, USER.id));
  await dispatch(callbackUpdateAs(`usr:det:${U.pay.id}:det:0:paywait`, nextId(), USER, USER.id));
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n, usersBefore);
  const newSends = stub.sent.slice(sendsBefore).filter((s) => s.method === 'sendMessage');
  assert.equal(newSends.length, 0, 'no dashboard content leaks to non-admin');
});

test('parser: old forms default to all, hostile rejected', async () => {
  assert.deepEqual(parseUsersCallback('usr:list:det:0'), { action: 'list', next: 'det', page: 0, filter: 'all' });
  assert.deepEqual(parseUsersCallback(`usr:det:${U.pay.id}:det:2`), {
    action: 'det',
    tgid: String(U.pay.id),
    next: 'det',
    page: 2,
    filter: 'all',
  });
  assert.deepEqual(parseUsersCallback('usr:list:det:0:paywait'), {
    action: 'list',
    next: 'det',
    page: 0,
    filter: 'paywait',
  });
  assert.equal(parseUsersCallback('usr:filter')?.action, 'filter');
  assert.equal(parseUsersCallback('usr:list:det:0:bogus'), null);
  assert.equal(parseUsersCallback('usr:det:1:det:0:ALL'), null);
  assert.equal(parseUsersCallback('usr:filter:x'), null);
  assert.equal(parseUsersCallback('usr:list:xx:0:active'), null);
  assert.equal(isValidCallbackData('usr:filter'), true);
  assert.equal(isValidCallbackData('usr:list:det:0:deleted'), true);
  assert.equal(isValidCallbackData('usr:list:det:0:bogus'), false);
});

test('filter browsing: no panel calls, no secrets, bubbles under the cap', async () => {
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs('usr:filter', nextId(), ADMIN, ADMIN.id));
  for (const f of ['all', 'active', 'paywait', 'review', 'failed', 'deleted']) {
    await dispatch(callbackUpdateAs(`usr:list:det:0:${f}`, nextId(), ADMIN, ADMIN.id));
  }
  await dispatch(callbackUpdateAs(`usr:det:${U.active.id}:det:0:active`, nextId(), ADMIN, ADMIN.id));
  assert.equal(stub.panel.calls.length, 0, 'filter screens never touch the panel');
  for (const s of stub.sent.filter((m) => m.method === 'sendMessage')) {
    const text = String(s.text);
    assert.ok(text.length < 4000, 'bubble under the cap');
    assert.ok(!text.includes('SECRET_'), 'no subscription secrets');
    assert.ok(!text.includes('PG-TEST-KEY'), 'no panel key');
  }
});
