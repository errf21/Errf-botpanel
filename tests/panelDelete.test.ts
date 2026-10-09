/**
 * Phase 16 — admin panel-service delete + the `panel_deleted` disposition.
 *
 * Covers every required behavior, in order:
 *  1. successful admin deletion (e2e /panel_del via username AND via order
 *     id): card with explicit confirm/cancel, ONE DELETE + confirming read,
 *     guarded D1 stamp, audit event, recipient-language customer notice;
 *  2. cancel = zero writes;
 *  3. non-admin: command refused (cmdAdminOnly), forged confirm tap neutral,
 *     zero panel traffic in both cases;
 *  4. failed/ambiguous panel delete NEVER books the local disposition;
 *  5. a manual panel-side deletion is reconciled by the customer live refresh
 *     and by the usage sweep (one stamp, 'system:*' actors);
 *  6. deleted services are neither listed nor renewable nor re-provisionable
 *     (and stay out of the /failed retry queue);
 *  7. idempotency: concurrent double taps and stale re-taps collapse into one
 *     stamp + one event (guarded UPDATE), with converging final cards.
 * Plus the migration 0015 schema assertions (columns, terminal partial index).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
import { provisionUsername } from '../src/provision/provision.ts';
import type { ProvisionDeps } from '../src/provision/provision.ts';
import { provisionOrder } from '../src/provision/provision.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const PANEL_BASE = 'https://panel.test';
const PANEL_KEY = 'PG-SECRET-KEY-42';

/* ————————————————————————————— panel stub ————————————————————————————— */

interface FakeUser {
  id: string;
  username: string;
  status: string;
  subscription_url: string;
  expire: number;
  data_limit: number;
  used_traffic: number;
}

const users = new Map<string, FakeUser>();
let panelSeq = 100;
const scenario = {
  deleteMode: 'ok' as 'ok' | 'fail500' | 'ignored' | 'gone',
};

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
      subscription_url: `/sub/${username}/SUBLINK`,
      expire: Number(body['expire'] ?? 0),
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
    };
    users.set(username, record);
    return Response.json({ data: { ...record } });
  }
  if (request.method === 'DELETE' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    if (scenario.deleteMode === 'fail500') {
      return Response.json({ detail: 'delete refused' }, { status: 500 });
    }
    if (scenario.deleteMode === 'ignored') {
      // Panel returns success but keeps the service — must NOT be booked.
      return Response.json({ detail: 'ok', deleted: false });
    }
    if (scenario.deleteMode === 'gone' || !users.has(username)) {
      return Response.json({ detail: 'Not Found' }, { status: 404 });
    }
    users.delete(username);
    return Response.json({ ok: true });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

/* ————————————————————————————— harness ————————————————————————————— */

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const db = shim as unknown as D1Database;
const { processTelegramUpdate } = await import('../src/dispatch.ts');
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: PANEL_KEY,
  PASARGUARD_PANEL_URL: PANEL_BASE,
} as unknown as Parameters<typeof processTelegramUpdate>[1];
const quietDeps = { env, db, api: { sendMessage: async () => true } } as unknown as ProvisionDeps;

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};

let counter = 12000;
const nextId = () => ++counter;

const { fa } = await import('../src/telegram/texts.ts');

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
const editedTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'editMessageText');
const buttonsOf = (chatId: number) => {
  const data: string[] = [];
  for (const s of sentTo(chatId)) {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) if (b.callback_data !== undefined) data.push(b.callback_data);
    }
  }
  return data;
};
const deletes = () =>
  stub.panel.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/api/user/by-username/'));
const orderById = (id: string) =>
  sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as Record<string, unknown>;
const eventsOf = (id: string) =>
  (sqlite.prepare('SELECT action FROM order_events WHERE order_id = ?1 ORDER BY id').all(id) as {
    action: string;
  }[]).map((r) => r.action);

/** buy → receipt → approve → completed service; returns the order id. */
async function purchaseToCompleted(name: string): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, name, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:1', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `PD_${nextId()}` }, USER));
  const awaiting = sqlite
    .prepare(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(String(USER.id)) as { id: string };
  await dispatch(callbackUpdateAs(`adm:ok:${awaiting.id}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(orderById(awaiting.id)['state'], 'completed', 'service completed first');
  return awaiting.id;
}

/** A FAILED order that still holds a provisioned service (orphan cleanup). */
async function purchaseThenForceFailed(serviceName: string, receiptId: string): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, serviceName, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:1', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: receiptId }, USER));
  const awaiting = (sqlite.prepare(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
      ORDER BY o.created_at DESC LIMIT 1`,
  ).get(String(USER.id)) as { id: string }).id;
  const { approveOrderByAdmin } = await import('../src/db/orders.ts');
  await approveOrderByAdmin(db, awaiting, String(ADMIN.id));
  const outcome = await provisionOrder(quietDeps, { orderId: awaiting });
  assert.equal(outcome.ok, true, 'creates the orphan service');
  sqlite.prepare('UPDATE orders SET state = ?1 WHERE id = ?2').run('failed', awaiting);
  return awaiting;
}

/* ————— 0. migration shape ————— */

test('migration 0015 adds the two disposition columns + the terminal partial index (additive only)', () => {
  const sql = readFileSync(`${here}../migrations/0015_panel_delete.sql`, 'utf8');
  assert.ok(/ADD COLUMN panel_deleted_at TEXT/.test(sql));
  assert.ok(/ADD COLUMN panel_deleted_by TEXT/.test(sql));
  assert.ok(!/DROP TABLE|DELETE FROM|UPDATE orders/i.test(sql), 'additive only — never destroys history');
  // Applies cleanly on a fresh DB (already carried by the harness) and on a
  // RAW pre-migration DB (the real deploy path).
  sqlite.prepare("SELECT panel_deleted_at, panel_deleted_by FROM orders LIMIT 1").all();
  const raw = new DatabaseSync(':memory:');
  const preFiles = [
    '0001_init.sql', '0002_phase2.sql', '0003_phase3.sql', '0004_phase4.sql', '0005_phase5.sql',
    '0006_phase6.sql', '0007_phase7.sql', '0008_phase8c.sql', '0009_phase9.sql', '0010_phase10.sql',
    '0011_pricing_model.sql', '0012_device_limit.sql', '0013_sales_switch.sql', '0014_free_test.sql',
  ];
  for (const f of preFiles) raw.exec(readFileSync(`${here}../migrations/${f}`, 'utf8'));
  raw.exec(`INSERT INTO customers (telegram_user_id) VALUES ('700001');`);
  raw.exec(`INSERT INTO orders (id, customer_id, selections, amount) VALUES ('O1', 1, '{"volume_gb":10}', 45000);`);
  raw.exec(sql);
  const d = raw.prepare('PRAGMA table_info(orders)').all() as { name: string }[];
  const names = d.map((c) => c.name);
  assert.ok(names.includes('panel_deleted_at'));
  assert.ok(names.includes('panel_deleted_by'));
  const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'").all() as { name: string }[];
  assert.ok(idx.some((r) => r.name === 'idx_orders_panel_alive'));
  // Existing rows survive untouched (history is never rewritten).
  const kept = raw.prepare("SELECT panel_deleted_at, panel_deleted_by FROM orders WHERE id = 'O1'").get() as
    { panel_deleted_at: string | null; panel_deleted_by: string | null };
  assert.equal(kept.panel_deleted_at, null);
  assert.equal(kept.panel_deleted_by, null);
  raw.close();
});

/* ————— 1. successful admin deletion (username AND order-id addressing) ————— */

test('admin delete via username: explicit card, one DELETE + confirm read, guarded stamp, notice', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('deleteMe7');
  const username = provisionUsername(orderId, 'pg');
  assert.ok(users.has(username));
  stub.reset();
  stub.panel.reset();

  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username.toUpperCase()}`, nextId()));
  await flush();
  const card = textsTo(ADMIN.id).at(-1) ?? '';
  assert.ok(card.includes(orderId), 'card names the order');
  assert.ok(card.includes(username), 'card names the panel username');
  assert.ok(card.includes('deleteMe7'), 'card echoes the config name (history visible)');
  assert.ok(card.includes(fa.adminPdlWarning), 'card carries the explicit warning');
  const btns = buttonsOf(ADMIN.id);
  assert.ok(btns.includes(`pdel:ok:${orderId}`), 'confirm button');
  assert.ok(btns.includes(`pdel:no:${orderId}`), 'cancel button');
  assert.equal(stub.panel.calls.length, 0, 'resolution never touches the panel');

  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  const methods = stub.panel.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(methods, [`GET /api/user/by-username/${username}`, `DELETE /api/user/by-username/${username}`, `GET /api/user/by-username/${username}`]);
  assert.equal(users.has(username), false, 'service gone from the panel');
  const row = orderById(orderId);
  assert.equal(row['state'], 'completed', 'history state preserved');
  assert.ok(typeof row['panel_deleted_at'] === 'string' && (row['panel_deleted_at'] as string).length > 0);
  assert.equal(row['panel_deleted_by'], `admin:${String(ADMIN.id)}`);
  assert.equal(row['failure_reason'], null);
  assert.ok((row['pasarguard_username'] as string).length > 0, 'username row preserved (anti-reuse)');
  const evts = eventsOf(orderId);
  assert.equal(evts.filter((a) => a === 'service_panel_deleted').length, 1);
  const retire = editedTo(ADMIN.id).at(-1);
  assert.ok(String(retire?.text).includes(fa.adminPdlDone(orderId).slice(0, 12)), 'card retired to done');
  const toasts = stub.sent.filter((s) => s.method === 'answerCallbackQuery');
  assert.ok(toasts.length >= 1);
  assert.ok(textsTo(USER.id).some((t) => t.includes(fa.serviceRevokedNotice('deleteMe7').slice(0, 10))), 'customer notified (recipient language, fa here)');
});

test('admin delete via order id works identically; unknown ids refused quietly', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('byidLake7');
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${orderId}`, nextId()));
  await flush();
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes(fa.adminPdlConfirmHeader(orderId))), 'card via order id');
  stub.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.ok(users.has(provisionUsername(orderId, 'pg')) === false);
  assert.ok(orderById(orderId)['panel_deleted_at'] !== null);

  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/panel_del nonexistent-name', nextId()));
  await flush();
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes(fa.pdlNotFound)));
  assert.equal(stub.panel.calls.length, 0, 'a missing target is resolved purely in D1');
});

/* ————— 2. cancel ————— */

test('cancel from the confirmation card changes NOTHING', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('cancelled7');
  const username = provisionUsername(orderId, 'pg');
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${orderId}`, nextId()));
  await flush();
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(stub.panel.calls.length, 0, 'no panel write of any kind');
  const row = orderById(orderId);
  assert.equal(row['panel_deleted_at'], null, 'no local disposition');
  assert.ok(users.has(username), 'panel user untouched');
  assert.ok(String(editedTo(ADMIN.id).at(-1)?.text).includes(fa.pdlCancelled));
  // The card is dead now — a later typed command re-arms a FRESH confirmation.
});

/* ————— 3. unauthorized ————— */

test('non-admins cannot delete: command and forged tap both neutral, zero panel traffic', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('guarded7');
  const username = provisionUsername(orderId, 'pg');
  assert.ok(users.has(username));
  const OTHER = { id: 424242424, first_name: 'Other', language_code: 'fa' };
  await dispatch(messageUpdateAs(OTHER, '/start', nextId()));
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(OTHER, `/panel_del ${username}`, nextId()));
  await flush();
  const otherTexts = stub.sent
    .filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === OTHER.id)
    .map((s) => String(s.text));
  assert.ok(otherTexts.some((t) => t.includes(fa.cmdAdminOnly)), 'standard admin-only refusal');
  const rowMid = orderById(orderId);
  assert.equal(rowMid['panel_deleted_at'], null, 'no stamp without authority');
  assert.equal(users.has(username), true, 'no panel delete without authority');
  assert.equal(stub.panel.calls.length, 0);
  // Forged confirm tap straight from the customer side.
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), OTHER, OTHER.id));
  await flush();
  assert.equal(stub.panel.calls.length, 0, 'router gates pdel: hard before touching anything');
  assert.equal(orderById(orderId)['panel_deleted_at'], null);
});

/* ————— 4. fail closed on panel failure / ambiguity ————— */

test('panel 500 on DELETE: alert toast, retryable card, NOTHING booked', async () => {
  const orderId = await purchaseToCompleted('failing7');
  const username = provisionUsername(orderId, 'pg');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  scenario.deleteMode = 'fail500';
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(stub.panel.calls.filter((c) => c.method === 'DELETE').length, 1, 'one attempt, no retry');
  const row = orderById(orderId);
  assert.equal(row['panel_deleted_at'], null, 'D1 untouched');
  assert.ok(users.has(username), 'panel user untouched');
  const alert = stub.sent.filter((s) => s.method === 'answerCallbackQuery' && s.payload['show_alert'] === true);
  assert.ok(alert.length >= 1, 'admin sees an alert on failure');
  const retried = editedTo(ADMIN.id).at(-1);
  assert.ok(String(retried?.text).includes(fa.adminPdlFailed(orderId, 'server:500:delete refused').slice(0, 12)), 'reason visible on the card');
  scenario.deleteMode = 'ok';
  // Same card can succeed now (guarded retry path).
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.ok(orderById(orderId)['panel_deleted_at'] !== null, 'retry converges');
  assert.equal(eventsOf(orderId).filter((a) => a === 'service_panel_deleted').length, 1);
});

test('panel answering success while KEEPING the service is never booked', async () => {
  const orderId = await purchaseToCompleted('lying7');
  const username = provisionUsername(orderId, 'pg');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  scenario.deleteMode = 'ignored';
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(orderById(orderId)['panel_deleted_at'], null, 'panel disagreement wins — no local claim');
  assert.ok(users.has(username));
  scenario.deleteMode = 'ok';
});

/* ————— 5. manual panel-side deletion is reconciled ————— */

test('customer live refresh seeing panel 404 stamps the disposition (system:svc-refresh)', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('vanished7');
  const username = provisionUsername(orderId, 'pg');
  users.delete(username); // deleted directly on the panel by its operator
  sqlite.prepare('UPDATE orders SET state = ?1 WHERE id = ?2').run('completed', orderId);
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`svc:ref:${orderId}`, nextId(), USER, USER.id));
  await flush();
  const row = orderById(orderId);
  assert.ok(row['panel_deleted_at'] !== null, 'reconciled');
  assert.equal(row['panel_deleted_by'], 'system:svc-refresh');
  assert.equal(eventsOf(orderId).filter((a) => a === 'service_panel_deleted').length, 1);
  assert.equal(stub.panel.calls.filter((c) => c.method === 'DELETE').length, 0, 'observers never delete');
  // The in-place edit just rendered the honest gone-state.
  assert.ok(String(editedTo(USER.id).at(-1)?.text).includes(fa.svcPanelGone), 'refresh says gone');
  // The list no longer returns it, and a later detail tap is not-found.
  const cid = Number(row['customer_id']);
  const { listServicesForCustomer } = await import('../src/db/orders.ts');
  const services = await listServicesForCustomer(db, cid, 50);
  assert.ok(!services.some((r) => r.id === orderId), 'deleted service gone from the list query');
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${orderId}`, nextId(), USER));
  await flush();
  const toast = stub.sent.filter((s) => s.method === 'answerCallbackQuery').at(-1);
  assert.ok(String(toast?.payload['text']).includes(fa.serviceNotFound.slice(0, 6)), 'honest not-found now');
});

test('usage sweep seeing panel 404 stamps the disposition (system:notice-sweep) exactly once', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('sweptSea7');
  const username = provisionUsername(orderId, 'pg');
  const u = users.get(username);
  assert.ok(u, 'service exists pre-delete');
  u.data_limit = 2_000_000_000;
  u.used_traffic = 1_900_000_000; // inside the usage90 candidate window
  users.delete(username);         // …but it is gone on the panel itself
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const res = await runServiceNotificationSweep(env, Date.now());
  assert.equal(res.usageSent, 0);
  const first = orderById(orderId);
  assert.ok(first['panel_deleted_at'] !== null, 'sweep recorded the terminal state');
  assert.equal(first['panel_deleted_by'], 'system:notice-sweep');
  assert.equal(eventsOf(orderId).filter((a) => a === 'service_panel_deleted').length, 1);
  // A sweep re-run changes nothing (candidate filtered out, stamp guarded).
  await runServiceNotificationSweep(env, Date.now() + 3_600_000);
  assert.equal(eventsOf(orderId).filter((a) => a === 'service_panel_deleted').length, 1);
});

/* ————— 6. deleted services are inactive and unreusable ————— */

test('deleted services refuse renewal, retry, and re-provisioning with ZERO panel writes', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('retired7');
  const username = provisionUsername(orderId, 'pg');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.ok(orderById(orderId)['panel_deleted_at'] !== null);
  stub.reset();
  stub.panel.reset();

  const OTHER = USER;
  // query-level exclusion (the list itself renders through this query)
  const { listServicesForCustomer } = await import('../src/db/orders.ts');
  const cid = Number(orderById(orderId)['customer_id']);
  const services = await listServicesForCustomer(db, cid, 50);
  assert.ok(!services.some((r) => r.id === orderId), 'deleted service invisible to My Services');
  await dispatch(callbackUpdateAs('menu:services', nextId(), OTHER));
  await flush();
  await dispatch(callbackUpdateAs(`svc:rnw:${orderId}`, nextId(), OTHER, OTHER.id));
  await flush();
  const rnwToasts = stub.sent.filter((s) => s.method === 'answerCallbackQuery');
  const rnwToast = rnwToasts.at(-1);
  assert.ok(rnwToasts.some((s) => String(s.payload['text']).includes(fa.renewRetiredNotice.slice(0, 12))), 'retired renewal answered');
  assert.ok(String(rnwToast?.payload['text']).includes(fa.serviceNotFound.slice(0, 6)));
  assert.equal(stub.panel.calls.length, 0, 'not even a renewal read happens');

  // manual provisionOrder on the deleted row refuses instantly
  const re = await provisionOrder(quietDeps, { orderId, retry: true });
  assert.equal(re.ok, false);
  assert.deepEqual(re, { ok: false, error: 'state_changed' });
  assert.equal(stub.panel.calls.filter((c) => c.method === 'POST').length, 0, 'never re-created');
});

test('a deleted orphan (failed order + provisioned service) leaves /failed and refuses retry', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('orphan7');
  const username = provisionUsername(orderId, 'pg');
  // force it to failed while KEEPING the claimed username + panel service
  sqlite.prepare('UPDATE orders SET state = ?1 WHERE id = ?2').run('failed', orderId);
  const { showFailedQueue } = await import('../src/handlers/provisioning.ts');
  void showFailedQueue;
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/failed', nextId()));
  await flush();
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes(orderId)), 'normally queued for retry');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${orderId}`, nextId()));
  await flush();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.ok(users.has(username) === false);
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/failed', nextId()));
  await flush();
  assert.ok(!textsTo(ADMIN.id).some((t) => t.includes(orderId)), 'deleted orphan exits the retry queue');
  const rt = await provisionOrder(quietDeps, { orderId, retry: true });
  assert.equal(rt.ok, false, 'and the claim itself refuses it');
  assert.equal(stub.panel.calls.filter((c) => c.method === 'POST').length, 0, 'never re-provisioned');
});

/* ————— 7. idempotency / races ————— */

test('concurrent double-taps and stale re-taps collapse to exactly one stamp + one event', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('raced7');
  const username = provisionUsername(orderId, 'pg');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  stub.reset();
  stub.panel.reset();
  await Promise.all([
    dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id)),
    dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id)),
  ]);
  await flush();
  const dl = deletes().length;
  assert.ok(dl >= 1 && dl <= 2, 'at most one actual service removal attempt each');
  const row = orderById(orderId);
  assert.ok(row['panel_deleted_at'] !== null, 'disposition booked');
  assert.equal(eventsOf(orderId).filter((a) => a === 'service_panel_deleted').length, 1, 'exactly-once audit');
  assert.equal(textsTo(USER.id).filter((t) => t.includes(fa.serviceRevokedNotice('raced7').slice(0, 10))).length, 1, 'the customer is told exactly once');
  stub.reset();
  stub.panel.reset();
  // A later stale tap on an already-deleted card: zero panel traffic, idempotent answer.
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(stub.panel.calls.filter((c) => c.method === 'DELETE').length, 0, 'already-deleted row never re-deleted');
  assert.ok(textsTo(ADMIN.id).length === 0);
});

test('already-deleted service: /panel_del answers pdlAlready with zero panel reads', async () => {
  scenario.deleteMode = 'ok';
  const orderId = await purchaseToCompleted('twiceGone7');
  const username = provisionUsername(orderId, 'pg');
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  await dispatch(callbackUpdateAs(`pdel:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, `/panel_del ${username}`, nextId()));
  await flush();
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes(fa.pdlAlready)));
  assert.equal(stub.panel.calls.length, 0, 'a booked deletion is not even re-checked on the panel');
});
