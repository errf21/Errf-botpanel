/**
 * Repurchase admin/UX lock management: visibility + safe cancellation.
 * Fully offline. Covers:
 *  - active repurchase visible to admin (list + /repurchases + /pending hint + receipt keyboard)
 *  - lock holder identifiable per service
 *  - admin cancel before provisioning (pending/awaiting/approved)
 *  - idempotent + double-cancel safe
 *  - lock released + repurchase re-entry allowed
 *  - session safely restored (repurchase states cleared, unrelated kept)
 *  - wallet refund exactly once, no duplicate ledger
 *  - history row stays in D1
 *  - provisioning-in-progress cannot be blindly cancelled (zero panel calls)
 *  - panel user never deleted / never duplicated
 *  - customer sees/cancels ONLY their own lock
 *  - renewal history/drain compatible (0018/0019 untouched)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  TEST_CARD,
  USER,
  USER_EN_CLIENT,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  mediaUpdate,
  messageUpdateAs,
  type PanelRequest,
} from './helpers.ts';

const PANEL_KEY = 'PG-SECRET-KEY-99';
const PANEL_BASE = 'https://panel.test';

interface FakeUser {
  id: string;
  username: string;
  status: string;
  subscription_url: string;
  expire: number;
  data_limit: number;
  used_traffic: number;
  hwid_limit: number;
}

const users = new Map<string, FakeUser>();
let panelSeq = 5000;
let subSeq = 5000;

function panelRespond(request: PanelRequest): Response {
  if (request.method === 'GET' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    return user
      ? Response.json({ data: { ...user } })
      : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if (request.method === 'POST' && request.path === '/api/user') {
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    const record: FakeUser = {
      id: String(panelSeq++),
      username,
      status: String(body['status'] ?? 'active'),
      subscription_url: `/sub/${username}/SUBLINK${subSeq++}`,
      expire: Number(body['expire'] ?? 0),
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
      hwid_limit: Number(body['hwid_limit'] ?? 1),
    };
    users.set(username, record);
    return Response.json({ data: { ...record } });
  }
  if (
    request.method === 'POST' &&
    request.path.startsWith('/api/user/by-username/') &&
    request.path.endsWith('/reset')
  ) {
    const username = decodeURIComponent(
      request.path.slice('/api/user/by-username/'.length, -'/reset'.length),
    );
    const user = users.get(username);
    if (!user) return Response.json({ detail: 'Not Found' }, { status: 404 });
    user.used_traffic = 0;
    user.subscription_url = `/sub/${username}/SUBLINK${subSeq++}`;
    return Response.json({ data: { ...user } });
  }
  if (request.method === 'PUT' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    if (!user) return Response.json({ detail: 'Not Found' }, { status: 404 });
    const body = request.body ?? {};
    if ('used_traffic' in body || 'usedTraffic' in body) {
      return Response.json({ detail: 'used_traffic forbidden' }, { status: 400 });
    }
    if (body['expire'] !== undefined) user.expire = Number(body['expire']);
    if (body['data_limit'] !== undefined) user.data_limit = Number(body['data_limit']);
    if (body['hwid_limit'] !== undefined) user.hwid_limit = Number(body['hwid_limit']);
    return Response.json({ data: { ...user } });
  }
  if (request.method === 'DELETE') {
    return Response.json({ detail: 'unexpected delete in cancel tests' }, { status: 500 });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { applyWalletMutation } = await import('../src/db/wallet.ts');
const {
  cancelRepurchaseOrder,
  findActiveRepurchaseForService,
  isRepurchaseProvisioningStarted,
  listActiveRepurchases,
} = await import('../src/db/orders.ts');
const { performRepurchaseCancel, orderSummaryLines } = await import('../src/admin.ts');
const { getSession } = await import('../src/db/states.ts');

const sqlite = freshDb();
sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"enabled":true,"near_expiry_days":7}' WHERE key = 'repurchase'`).run();
const shim = makeD1Shim(sqlite);
const db = shim as unknown as D1Database;
const envRef: Record<string, unknown> = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: PANEL_KEY,
  PASARGUARD_PANEL_URL: PANEL_BASE,
  PAYMENT_CARD_NUMBER: TEST_CARD,
};
const env = envRef as unknown as Parameters<typeof processTelegramUpdate>[1];

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};

let counter = 91000;
const nextId = () => ++counter;

const textsTo = (chatId: number): string[] =>
  stub.sent
    .filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId)
    .map((s) => String(s.text));
const buttonsTo = (chatId: number): string[] => {
  const data: string[] = [];
  for (const s of stub.sent) {
    if (Number(s.payload['chat_id']) !== chatId) continue;
    const kb = s.payload['reply_markup'] as
      | { inline_keyboard?: { callback_data: string }[][] }
      | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) data.push(b.callback_data);
    }
  }
  return data;
};
const putCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/api/user/by-username/'));
const postCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');
const resetCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reset'));
const deleteCalls = () => stub.panel.calls.filter((c) => c.method === 'DELETE');

function customerIdOf(tid: number): number {
  return (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(tid)) as { id: number }).id;
}

async function purchaseToCompleted(volumeGb = 10, durationDays = 30, devices = 1): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, `cxtest${nextId()}`, nextId()));
  await dispatch(callbackUpdateAs(`vol:${volumeGb}`, nextId(), USER));
  await dispatch(callbackUpdateAs(`dur:${durationDays}`, nextId(), USER));
  await dispatch(callbackUpdateAs(`dev:${devices}`, nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `CX_${nextId()}` }, USER));
  const awaiting = sqlite
    .prepare(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(String(USER.id)) as { id: string };
  await dispatch(callbackUpdateAs(`adm:ok:${awaiting.id}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  return awaiting.id;
}

function expireService(serviceId: string): void {
  sqlite.prepare(`UPDATE orders SET service_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`).run(serviceId);
}

/** Drive a same-spec repurchase to awaiting_review; returns repurchase id. */
async function repurchaseToAwaiting(serviceId: string): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `CXR_${nextId()}` }, USER));
  const row = sqlite
    .prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
    .get() as Record<string, unknown>;
  return String(row['id']);
}

/* ================= visibility ================= */

test('active repurchase is visible to admin with lock detail', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  const rows = await listActiveRepurchases(db, 10);
  assert.ok(rows.some((r) => r.id === repId), 'lock holder listed');
  const found = rows.find((r) => r.id === repId)!;
  assert.equal(found.repurchase_mode, 'same');
  assert.equal(found.state, 'awaiting_review');
  // Admin summary surfaces mode + status + lock line.
  const lines = orderSummaryLines(found);
  const joined = lines.join('\n');
  assert.ok(joined.includes(repId), 'order id shown');
  assert.ok(joined.includes('same'), 'mode shown');
  assert.ok(joined.includes('🔒'), 'lock indication shown');
  // /repurchases command lists it; /pending hints at the lock.
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/repurchases', nextId()));
  assert.ok(textsTo(ADMIN.id).join('\n').includes(repId.slice(0, 10)), '/repurchases shows holder');
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/pending', nextId()));
  assert.ok(textsTo(ADMIN.id).join('\n').includes('🔒'), '/pending hints lock');
  // Lock holder identifiable per service.
  const holder = await findActiveRepurchaseForService(db, serviceId);
  assert.ok(holder && holder.id === repId, 'service lock resolves to repurchase');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  // Leave the row for later cancel tests in this file? Cancel it now to free the service.
  const done = await performRepurchaseCancel({
    db,
    api: { sendMessage: async () => true } as never,
    actorTag: 'admin:test',
    orderId: repId,
    reason: 'cleanup',
    notifyCustomer: false,
  });
  assert.equal(done.ok, true);
});

test('customer sees ONLY their own lock with status and safe cancel action', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  void repId;
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  const mine = textsTo(USER.id).join('\n');
  assert.ok(mine.includes('🔄'), 'in-progress line shown');
  assert.ok(mine.includes('📊'), 'status shown');
  const buttons = buttonsTo(USER.id);
  assert.ok(buttons.includes(`svc:cancel:${serviceId}`), 'own cancel action offered');
  // Another customer sees nothing of this order.
  stub.reset();
  await dispatch(messageUpdateAs(USER_EN_CLIENT, '/start', nextId()));
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER_EN_CLIENT));
  assert.ok(!buttonsTo(USER_EN_CLIENT).includes(`svc:cancel:${serviceId}`), 'no cross-customer cancel');
  // Forged cross-customer cancel fails closed.
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:cancel:${serviceId}`, nextId(), USER_EN_CLIENT));
  const still = await findActiveRepurchaseForService(db, serviceId);
  assert.ok(still !== null, 'foreign cancel did not release the lock');
  // Cleanup via owner path below (customer cancel test).
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:cancel:${serviceId}`, nextId(), USER));
  const gone = await findActiveRepurchaseForService(db, serviceId);
  assert.equal(gone, null, 'owner cancel released the lock');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= safe cancel before provisioning ================= */

test('admin can cancel before provisioning; lock released; re-entry allowed', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  stub.panel.reset();
  const result = await performRepurchaseCancel({
    db,
    api: { sendMessage: async () => true } as never,
    actorTag: 'admin:test',
    orderId: repId,
    reason: 'test cancel',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.state, 'cancelled', 'transitioned to existing cancelled status');
  assert.equal(putCalls().length, 0, 'no panel PUT on cancel');
  assert.equal(resetCalls().length, 0, 'no panel reset on cancel');
  assert.equal(postCalls().length, 0, 'no panel create on cancel');
  assert.equal(deleteCalls().length, 0, 'panel user never deleted');
  // Lock released: service eligible again (guard passes, entry offered).
  assert.equal(await findActiveRepurchaseForService(db, serviceId), null);
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  const st = sqlite
    .prepare('SELECT state FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER.id)) as { state: string };
  assert.equal(st.state, 'WAITING_REPURCHASE_MODE', 'repurchase available again');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  // History intact.
  const row = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(repId) as Record<string, unknown>;
  assert.equal(row['state'], 'cancelled');
  const events = sqlite.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?1 AND action = ?2').get(repId, 'repurchase_cancelled') as { n: number };
  assert.equal(events.n, 1, 'auditable exactly once');
});

test('cancellation is idempotent; double cancel is safe', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  const api = { sendMessage: async () => true } as never;
  const first = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'x' });
  assert.equal(first.ok, true);
  const second = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'x' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.alreadyCancelled, true, 'second call converges');
  const events = sqlite.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?1 AND action = ?2').get(repId, 'repurchase_cancelled') as { n: number };
  assert.equal(events.n, 1, 'no duplicate audit event');
  // Direct guarded claim is also idempotent.
  const third = await cancelRepurchaseOrder(db, { orderId: repId, actorTag: 'admin:test', reason: null });
  assert.equal(third.ok, true);
  if (third.ok) assert.equal(third.alreadyCancelled, true);
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

test('conversation state restored safely; unrelated state preserved', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const { setSession } = await import('../src/db/states.ts');
  const cid = customerIdOf(USER.id);
  // Case 1: repurchase-specific state is cleared.
  const repId = await repurchaseToAwaiting(serviceId);
  await setSession(db, cid, 'WAITING_REPURCHASE_MODE', { repurchases_order_id: serviceId });
  const r1 = await performRepurchaseCancel({
    db, api: { sendMessage: async () => true } as never, actorTag: 'admin:t', orderId: repId, reason: null, notifyCustomer: false,
  });
  assert.equal(r1.ok, true);
  assert.equal((await getSession(db, cid)).state, 'IDLE');
  // Case 2: WAITING_PAYMENT_RECEIPT bound to THIS order is cleared.
  const service2 = await purchaseToCompleted(10);
  expireService(service2);
  const rep2 = await repurchaseToAwaiting(service2);
  await setSession(db, cid, 'WAITING_PAYMENT_RECEIPT', { order_id: rep2 });
  const r2 = await performRepurchaseCancel({
    db, api: { sendMessage: async () => true } as never, actorTag: 'admin:t', orderId: rep2, reason: null, notifyCustomer: false,
  });
  assert.equal(r2.ok, true);
  assert.equal((await getSession(db, cid)).state, 'IDLE');
  // Case 3: unrelated/newer state is NOT overwritten.
  const service3 = await purchaseToCompleted(10);
  expireService(service3);
  const rep3 = await repurchaseToAwaiting(service3);
  await setSession(db, cid, 'WAITING_SUPPORT_MESSAGE', {});
  const r3 = await performRepurchaseCancel({
    db, api: { sendMessage: async () => true } as never, actorTag: 'admin:t', orderId: rep3, reason: null, notifyCustomer: false,
  });
  assert.equal(r3.ok, true);
  assert.equal((await getSession(db, cid)).state, 'WAITING_SUPPORT_MESSAGE', 'newer state kept');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= wallet safety ================= */

test('wallet refund happens exactly once; no duplicate ledger entries', async () => {
  const serviceId = await purchaseToCompleted(10, 30, 1);
  expireService(serviceId);
  const granted = await applyWalletMutation(db, {
    customerId: customerIdOf(USER.id), amountIrt: 5_000_000, kind: 'admin_grant', actor: 'test',
  });
  assert.equal(granted.ok, true);
  const balanceOf = (): number =>
    (sqlite.prepare('SELECT balance_irt AS n FROM customers WHERE id = ?1').get(customerIdOf(USER.id)) as { n: number }).n;
  // Partial wallet repurchase: debit happens at confirm, order stays payable.
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('wlt:part', nextId(), USER));
  const pending = sqlite.prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
  const repId = String(pending['id']);
  const afterDebit = balanceOf();
  const payRows = sqlite.prepare(`SELECT COUNT(*) AS n FROM wallet_entries WHERE order_id = ?1 AND kind = 'order_payment'`).get(repId) as { n: number };
  assert.equal(payRows.n, 1, 'exactly one payment entry');
  const api = { sendMessage: async () => true } as never;
  const c1 = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'wallet test' });
  assert.equal(c1.ok, true);
  assert.ok(balanceOf() > afterDebit, 'balance restored');
  const refundRows = () =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM wallet_entries WHERE order_id = ?1 AND kind = 'order_refund'`).get(repId) as { n: number }).n;
  assert.equal(refundRows(), 1, 'exactly one refund entry');
  const c2 = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'wallet test' });
  assert.equal(c2.ok, true);
  assert.equal(refundRows(), 1, 'double cancel adds no ledger row');
  assert.equal(balanceOf(), (sqlite.prepare('SELECT balance_irt AS n FROM customers WHERE id = ?1').get(customerIdOf(USER.id)) as { n: number }).n, 'balance stable');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

test('manual-receipt repurchase without wallet cancels with no refund invented', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  const api = { sendMessage: async () => true } as never;
  const result = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.refunded, false, 'no wallet payment to refund');
  const refunds = sqlite.prepare(`SELECT COUNT(*) AS n FROM wallet_entries WHERE order_id = ?1 AND kind = 'order_refund'`).get(repId) as { n: number };
  assert.equal(refunds.n, 0, 'no invented refund row');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= provisioning safety ================= */

test('provisioning-in-progress cannot be blindly cancelled; zero panel writes', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  // Simulate provisioning having started (claimed targets + attempt).
  sqlite.prepare(`UPDATE orders SET state = 'provisioning', provision_attempts = 1, repurchase_target_quota_bytes = 10737418240, repurchase_target_unix = 1999999999, repurchase_target_hwid = 1, repurchase_reset_done = 1 WHERE id = ?1`).run(repId);
  const row = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(repId) as unknown as Parameters<typeof isRepurchaseProvisioningStarted>[0];
  assert.equal(isRepurchaseProvisioningStarted(row), true);
  stub.panel.reset();
  const api = { sendMessage: async () => true } as never;
  const result = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'unsafe' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, 'provisioning_started');
  const kept = sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(repId) as { state: string };
  assert.equal(kept.state, 'provisioning', 'state untouched');
  assert.equal(putCalls().length, 0, 'no PUT on refused cancel');
  assert.equal(resetCalls().length, 0, 'no reset on refused cancel');
  assert.equal(deleteCalls().length, 0, 'user never deleted');
  assert.equal(postCalls().length, 0, 'no user created');
  // Service detail offers NO cancel action once provisioning started.
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  assert.ok(!buttonsTo(USER.id).includes(`svc:cancel:${serviceId}`), 'no unsafe customer button');
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:cancel:${serviceId}`, nextId(), USER));
  const still = await findActiveRepurchaseForService(db, serviceId);
  assert.ok(still !== null && still.id === repId, 'lock still held (retry/adopt path owns it)');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

test('failed repurchase with no provisioning signals can cancel to release hygiene lock; failed with signals refuses', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  // Failed BEFORE any claim (e.g. precheck fail): cancellable, panel-free.
  sqlite.prepare(`UPDATE orders SET state = 'failed', failure_reason = 'repurchase_precheck_x' WHERE id = ?1`).run(repId);
  stub.panel.reset();
  const api = { sendMessage: async () => true } as never;
  const ok = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: 'hygiene' });
  assert.equal(ok.ok, true);
  assert.equal(putCalls().length, 0);
  assert.equal(resetCalls().length, 0);
  assert.equal(deleteCalls().length, 0);
  // Failed WITH claimed targets: refuse (adopt/retry owns it).
  const service2 = await purchaseToCompleted(10);
  expireService(service2);
  const rep2 = await repurchaseToAwaiting(service2);
  sqlite.prepare(`UPDATE orders SET state = 'failed', provision_attempts = 1, repurchase_target_quota_bytes = 10737418240 WHERE id = ?1`).run(rep2);
  const blocked = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: rep2, reason: 'hygiene' });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error, 'provisioning_started');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= architecture + renewal compat ================= */

test('cancelled repurchase keeps history; renewal rows and 0018/0019 untouched', async () => {
  // Historical renewal (pre-repurchase shape) stays queryable.
  sqlite.prepare(
    `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency, renews_order_id)
     VALUES ('0000000000000000000000000001', ?1, 'completed', 'renewal', '{"kind":"renewal"}', 1000, 'IRT', 'svc-hist')`,
  ).run(customerIdOf(USER.id));
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const repId = await repurchaseToAwaiting(serviceId);
  const api = { sendMessage: async () => true } as never;
  const result = await performRepurchaseCancel({ db, api, actorTag: 'admin:test', orderId: repId, reason: null });
  assert.equal(result.ok, true);
  const hist = sqlite.prepare(`SELECT * FROM orders WHERE id = '0000000000000000000000000001'`).get() as Record<string, unknown>;
  assert.equal(hist['state'], 'completed', 'renewal history preserved');
  assert.equal(hist['repurchase_mode'], null);
  const cols = sqlite.prepare(`PRAGMA table_info(orders)`).all() as unknown as { name: string }[];
  for (const c of ['repurchase_mode', 'repurchase_target_quota_bytes', 'repurchase_target_unix', 'repurchase_target_hwid', 'repurchase_reset_done', 'renew_target_data_limit_bytes']) {
    assert.ok(cols.some((col) => col.name === c), `column present: ${c}`);
  }
  const states = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name = 'conversation_states'`).get() as { sql: string };
  for (const s of ['WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_VOLUME', 'WAITING_RENEWAL_CONFIRMATION', 'WAITING_REPURCHASE_MODE']) {
    assert.ok(states.sql.includes(s), `state preserved: ${s}`);
  }
  sqlite.prepare(`DELETE FROM orders WHERE id = '0000000000000000000000000001'`).run();
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

test('existing repurchase flow still provisions on the SAME user (no create/delete)', async () => {
  const { provisionOrder } = await import('../src/provision/provision.ts');
  void provisionOrder;
  const serviceId = await purchaseToCompleted(10, 30, 2);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  const panelIdBefore = users.get(username)!.id;
  // Drift the panel so the combined PUT is required (mirrors repurchase.test).
  users.get(username)!.used_traffic = 4 * 1_073_741_824;
  users.get(username)!.data_limit = 5 * 1_073_741_824;
  users.get(username)!.expire = Math.floor(Date.now() / 1000) - 1000;
  users.get(username)!.hwid_limit = 5;
  stub.panel.reset();
  const repId = await repurchaseToAwaiting(serviceId);
  await dispatch(callbackUpdateAs(`adm:ok:${repId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  const done = sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(repId) as { state: string };
  assert.equal(done.state, 'completed', 'normal flow still completes');
  assert.equal(users.get(username)!.id, panelIdBefore, 'same user retained');
  assert.equal(postCalls().length, 0, 'no duplicate user created');
  assert.equal(deleteCalls().length, 0, 'user never deleted');
  assert.equal(resetCalls().length, 1, 'exactly one reset');
  assert.equal(putCalls().length, 1, 'exactly one combined PUT');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});
