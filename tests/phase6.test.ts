/**
 * Phase 6 e2e: My Services + status + renewals — fully offline.
 * The panel stub (GET/POST/PUT /api/user...) script an in-memory service
 * store with real expire fields; nothing touches the network. Covers:
 * the services list/detail from the DB, the renewal ladder + priced
 * renewal order through the SHARED payment/review pipeline, the
 * extension-with-absolute-target apply (PUT exactly once), adopted retries
 * after ambiguous writes (no stacking), forward-only booking on the service
 * row, the attempt cap, ownership/forgery gates, the kill switch, and the
 * fail-closed invariant when the panel or renewal doc is unavailable.
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
import { newOrderId } from '../src/lib/security.ts';
import { isValidCallbackData, parseServiceCallback } from '../src/lib/validate.ts';
import { approveOrderByAdmin, rejectOrderByAdmin } from '../src/db/orders.ts';
import { loadCatalog } from '../src/catalog/catalog.ts';
import { calculateRenewalPrice } from '../src/catalog/pricing.ts';
import { checkoutRenewalOrder } from '../src/orders/checkout.ts';
import { reduce } from '../src/state/machine.ts';
import { fa, durationLabelFa, digitsFa } from '../src/telegram/texts.ts';
import { coerceUnixSeconds } from '../src/pasarguard/client.ts';
import type { ProvisionDeps } from '../src/provision/provision.ts';

const PANEL_KEY = 'PG-SECRET-KEY-42';
const PANEL_BASE = 'https://panel.test';
const DAY_SECONDS = 86_400;

interface FakeUser {
  id: string;
  username: string;
  status: string;
  subscription_url: string;
  expire: number; // unix seconds
  data_limit: number;
  used_traffic: number;
}

const users = new Map<string, FakeUser>();
let panelSeq = 100;
const scenario = {
  createFailures: 0,
  putMode: 'ok' as 'ok' | 'fail500' | 'ambiguous',
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
    if (scenario.createFailures > 0) {
      scenario.createFailures -= 1;
      return Response.json({ detail: 'panel down' }, { status: 500 });
    }
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    const record: FakeUser = {
      id: String(panelSeq++),
      username,
      status: String(body['status'] ?? 'active'),
      subscription_url: `/sub/${username}/SUBLINK`,
      expire: Math.floor(Date.now() / 1000) + Number(body['expire_duration'] ?? 0),
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
    };
    users.set(username, record);
    return Response.json({ data: { ...record } });
  }
  if (request.method === 'PUT' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    if (!user) return Response.json({ detail: 'Not Found' }, { status: 404 });
    if (scenario.putMode === 'fail500') {
      return Response.json({ detail: 'modify rejected' }, { status: 500 });
    }
    user.expire = Number((request.body ?? {})['expire'] ?? user.expire);
    if (scenario.putMode === 'ambiguous') {
      // The write LANDED but the response never arrived — retries must adopt.
      return Response.json({ detail: 'gateway timeout' }, { status: 504 });
    }
    return Response.json({ data: { ...user } });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { provisionOrder } = await import('../src/provision/provision.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const db = shim as unknown as D1Database;
const envRef: Record<string, unknown> = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: PANEL_KEY,
  PASARGUARD_PANEL_URL: PANEL_BASE,
};
const env = envRef as unknown as Parameters<typeof processTelegramUpdate>[1];

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};

let counter = 9000;
const nextId = () => ++counter;

const OTHER = { id: 555555555, first_name: 'Other', language_code: 'fa' };

interface OrderRow {
  id: string;
  state: string;
  kind: string;
  selections: string;
  amount: number;
  customer_id: number;
  pasarguard_username: string | null;
  service_expires_at: string | null;
  renew_target_unix: number | null;
  renews_order_id: string | null;
  provision_attempts: number;
}

function orderById(id: string): OrderRow | undefined {
  return sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as OrderRow | undefined;
}

function eventsOf(orderId: string): string[] {
  return (
    sqlite
      .prepare('SELECT action FROM order_events WHERE order_id = ?1 ORDER BY id')
      .all(orderId) as { action: string }[]
  ).map((row) => row.action);
}

function customerIdOf(user: { id: number }): number {
  return (
    sqlite
      .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
      .get(String(user.id)) as { id: number }
  ).id;
}

const textsTo = (chatId: number): string[] =>
  stub.sent
    .filter((s) => s.method === 'sendMessage')
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

/** buy → receipt → admin approve → panel create → completed service. */
async function purchaseToCompleted(user: typeof USER = USER): Promise<string> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, `cfg-${nextId()}`, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  await dispatch(callbackUpdateAs('dev:3', nextId(), user));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  await dispatch(
    mediaUpdate(nextId(), { kind: 'photo', fileId: `RECEIPT_${nextId()}` }, user),
  );
  const awaiting = sqlite
    .prepare(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(String(user.id)) as { id: string };
  await dispatch(callbackUpdateAs(`adm:ok:${awaiting.id}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  const row = orderById(awaiting.id);
  assert.equal(row?.state, 'completed');
  return awaiting.id;
}

/** Move a just-created order to awaiting_review so the guarded admin paths proceed. */
function forceAwaitingReview(orderId: string): void {
  sqlite
    .prepare(
      `UPDATE orders SET state='awaiting_review', receipt_file_id='X', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1 AND state = 'pending_payment'`,
    )
    .run(orderId);
}

/** Directly create + approve a renewal order for tests (bypass UI). */
async function directRenewalOrder(serviceId: string, days = 30): Promise<string> {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error);
  const computed = calculateRenewalPrice(loaded.catalog.pricing, { durationDays: days });
  assert.equal(computed.ok, true);
  if (!computed.ok) throw new Error(computed.error);
  const service = orderById(serviceId);
  const result = await checkoutRenewalOrder(
    db,
    {
      customerId: Number(service?.customer_id),
      orderToken: newOrderId(),
      catalog: loaded.catalog,
      breakdown: computed.breakdown,
      serviceOrderId: serviceId,
    },
    'direct-cfg',
  );
  assert.equal(result.ok, true);
  forceAwaitingReview(result.order.id);
  const approved = await approveOrderByAdmin(db, result.order.id, String(ADMIN.id));
  assert.equal(approved.ok, true);
  return result.order.id;
}

const quietDeps = {
  env,
  db,
  api: { sendMessage: async () => true },
} as unknown as ProvisionDeps;

/* ================= machine + validation units ================= */

test('machine: renewal ladder transitions and back map', () => {
  assert.equal(reduce('IDLE', 'renew_start'), 'WAITING_RENEWAL_DURATION');
  assert.equal(reduce('BUYING', 'renew_start'), 'BUYING'); // busy never hijacks
  assert.equal(reduce('WAITING_RENEWAL_DURATION', 'renew_duration_chosen'), 'WAITING_RENEWAL_CONFIRMATION');
  assert.equal(reduce('WAITING_RENEWAL_CONFIRMATION', 'renew_confirmed'), 'WAITING_PAYMENT_RECEIPT');
  assert.equal(reduce('WAITING_RENEWAL_CONFIRMATION', 'step_back'), 'WAITING_RENEWAL_DURATION');
  assert.equal(reduce('WAITING_RENEWAL_DURATION', 'step_back'), 'IDLE');
  assert.equal(reduce('WAITING_RENEWAL_DURATION', 'cancel'), 'IDLE');
});

test('svc callbacks: strict format, full 28-char id, parser round-trip', () => {
  const id = newOrderId();
  assert.ok(id.length === 28 && `svc:det:${id}`.length <= 64);
  for (const action of ['det', 'ref', 'rnw']) {
    const data = `svc:${action}:${id}`;
    assert.equal(isValidCallbackData(data), true);
    assert.deepEqual(parseServiceCallback(data), { action, orderId: id });
  }
  assert.equal(isValidCallbackData(`svc:view:${id}`), false); // unknown action
  assert.equal(isValidCallbackData(`svc:det:${id.slice(0, 27)}`), false); // truncated
  assert.equal(isValidCallbackData('svc:det:short'), false);
  assert.equal(isValidCallbackData(`svc:det:${id.toLowerCase()}`), false); // ids are UPPERCASE
  assert.equal(isValidCallbackData(`svc:det:${id}x`), false);
  assert.equal(parseServiceCallback(`svc:det:${id.slice(0, 27)}`), null);
});

test('renewal pricing: months × month_rate, integer-only, guarded', async () => {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const pricing = loaded.catalog.pricing;
  for (const [days, months, total] of [[30, 1, 120000], [60, 2, 240000], [90, 3, 360000]] as const) {
    const r = calculateRenewalPrice(pricing, { durationDays: days });
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    assert.equal(r.breakdown.months, months);
    assert.equal(r.breakdown.total, total);
    assert.equal(r.breakdown.kind, 'renewal');
  }
  assert.equal(calculateRenewalPrice(pricing, { durationDays: 0 }).ok, false);
  assert.equal(calculateRenewalPrice(pricing, { durationDays: -5 }).ok, false);
  assert.equal(calculateRenewalPrice(pricing, { durationDays: 1.5 }).ok, false);
});

test('display helpers: month labels and persian digits', () => {
  assert.equal(durationLabelFa(30), '۱ ماه');
  assert.equal(durationLabelFa(60), '۲ ماه');
  assert.equal(durationLabelFa(90), '۳ ماه');
  assert.equal(durationLabelFa(45), '۴۵ روز');
  assert.equal(digitsFa(12), '۱۲');
});

test('coerceUnixSeconds: tolerant but never invents', () => {
  assert.equal(coerceUnixSeconds(1_800_000_000), 1_800_000_000);
  assert.equal(coerceUnixSeconds(1_800_000_000_000), 1_800_000_000); // ms → s
  assert.equal(coerceUnixSeconds('1800000000'), 1800000000);
  assert.equal(coerceUnixSeconds('2027-01-15T10:00:00Z'), 1800007200); // Date.parse → s
  assert.equal(coerceUnixSeconds(new Date(1800000000 * 1000).toISOString()), 1800000000);
  assert.equal(coerceUnixSeconds(0), null); // panel "unlimited" marker
  assert.equal(coerceUnixSeconds(null), null);
  assert.equal(coerceUnixSeconds(-5), null);
  assert.equal(coerceUnixSeconds(5e9), null);
  assert.equal(coerceUnixSeconds('not a date'), null);
});

/* ================= services list + detail ================= */

test('menu:services is empty state for a user without services', async () => {
  await dispatch(messageUpdateAs(OTHER, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('menu:services', nextId(), OTHER));
  const texts = textsTo(OTHER.id);
  assert.ok(texts.some((t) => t.includes(fa.servicesEmpty)));
});

test('purchase → service appears in list with working detail', async () => {
  stub.reset();
  const serviceId = await purchaseToCompleted(USER);
  const username = `pg${serviceId.toLowerCase()}`;
  assert.ok(users.has(username));
  stub.reset();

  await dispatch(callbackUpdateAs('menu:services', nextId(), USER));
  const list = textsTo(USER.id).at(-1) ?? '';
  assert.ok(list.includes(fa.servicesHeader));
  assert.ok(list.includes(serviceId.slice(0, 10)));
  assert.ok(list.includes(fa.serviceStatusActive));
  assert.ok(buttonsTo(USER.id).includes(`svc:det:${serviceId}`));

  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  const detail = textsTo(USER.id).at(-1) ?? '';
  assert.ok(detail.includes(serviceId), 'full id shown');
  assert.ok(detail.includes(username), 'panel username shown');
  assert.ok(detail.includes('https://panel.test/sub/'), 'subscription link shown');
  const buttons = buttonsTo(USER.id);
  assert.ok(buttons.includes(`svc:rnw:${serviceId}`));
  assert.ok(buttons.includes(`svc:ref:${serviceId}`));
});

test('svc:ref does a live panel read and edits the detail in place', async () => {
  const serviceId = (
    sqlite
      .prepare(`SELECT id FROM orders WHERE kind = 'purchase' AND state = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  stub.reset();
  stub.panel.reset();
  await dispatch(
    callbackUpdateAs(`svc:ref:${serviceId}`, nextId(), USER, USER.id),
  );
  await flush();
  assert.ok(stub.sent.some((s) => s.method === 'editMessageText'));
  assert.ok(
    stub.panel.calls.some((c) => c.method === 'GET' && c.path.includes('/api/user/by-username/')),
    'panel was consulted',
  );
  const toast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.equal(String(toast?.payload['text']), fa.svcToastPanel);
});

test('svc:ref degrades to the local snapshot with no panel config', async () => {
  const serviceId = (
    sqlite
      .prepare(`SELECT id FROM orders WHERE kind = 'purchase' AND state = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  delete envRef.PASARGUARD_API_KEY;
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`svc:ref:${serviceId}`, nextId(), USER, USER.id));
  await flush();
  const edited = stub.sent.find((s) => s.method === 'editMessageText');
  assert.ok(String(edited?.text).includes(fa.svcSnapshotNote));
  assert.equal(stub.panel.calls.length, 0);
  envRef.PASARGUARD_API_KEY = PANEL_KEY;
});

/* ================= ownership + gates ================= */

test('services data never leaks to non-owners', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  await dispatch(messageUpdateAs(OTHER, '/start', nextId()));
  stub.reset();
  for (const action of ['det', 'ref', 'rnw'] as const) {
    await dispatch(callbackUpdateAs(`svc:${action}:${serviceId}`, nextId(), OTHER));
    await flush();
  }
  for (const s of stub.sent.filter((x) => x.method === 'answerCallbackQuery')) {
    assert.equal(String(s.payload['text']), fa.serviceNotFound);
  }
  assert.equal(stub.sent.filter((x) => x.method === 'sendMessage').length, 0);
});

test('svc:rnw while busy in another flow is refused (session untouched)', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'busy-cfg', nextId())); // → WAITING_VOLUME
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  const toast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.equal(String(toast?.payload['text']), fa.serviceBusyFirst);
  const state = sqlite
    .prepare('SELECT state FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER)) as { state: string };
  assert.equal(state.state, 'WAITING_VOLUME');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

test('only one renewal may be in flight per service', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const price = calculateRenewalPrice(loaded.catalog.pricing, { durationDays: 60 });
  assert.equal(price.ok, true);
  if (!price.ok) return;
  const first = await checkoutRenewalOrder(
    db,
    {
      customerId: customerIdOf(USER),
      orderToken: newOrderId(),
      catalog: loaded.catalog,
      breakdown: price.breakdown,
      serviceOrderId: serviceId,
    },
    'gate-cfg',
  );
  assert.equal(first.ok, true);

  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  const toast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.ok(String(toast?.payload['text']).includes(fa.renewInProgressNotice(first.order.id.slice(0, 10))));

  // detail shows the in-flight renewal badge and hides the renew button
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  const detail = textsTo(USER.id).at(-1) ?? '';
  assert.ok(detail.includes(fa.svcPendingRenewal(first.order.id.slice(0, 10))));
  assert.ok(!buttonsTo(USER.id).includes(`svc:rnw:${serviceId}`));

  forceAwaitingReview(first.order.id);
  const rejected = await rejectOrderByAdmin(db, first.order.id, String(ADMIN.id), 'test cleanup');
  assert.equal(rejected.ok, true);
});

test('renewal kill switch: disabled and malformed docs behave as unavailable', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  sqlite
    .prepare(`UPDATE settings SET value = json_set(value, '$.enabled', false) WHERE key = 'renewal'`)
    .run();
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  let toast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.equal(String(toast?.payload['text']), fa.renewDisabledNotice);

  sqlite.prepare(`UPDATE settings SET value = '{"garbage": true}' WHERE key = 'renewal'`).run();
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  toast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.equal(String(toast?.payload['text']), fa.renewDisabledNotice);

  sqlite
    .prepare(`UPDATE settings SET value = json_set(value, '$.enabled', true) WHERE key = 'renewal'`)
    .run();
  // restore a valid doc after the garbage test
  sqlite
    .prepare(
      `UPDATE settings SET value = '{"schema": 1, "enabled": true, "near_expiry_days": 7}' WHERE key = 'renewal'`,
    )
    .run();
});

/* ================= the renewal ladder end-to-end ================= */

test('UI renewal: ladder → priced renewal → receipt → approve → panel PUT once → booked', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  const username = `pg${serviceId.toLowerCase()}`;
  const expireBefore = users.get(username)!.expire;

  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  let state = sqlite
    .prepare('SELECT state, data FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER)) as { state: string; data: string };
  assert.equal(state.state, 'WAITING_RENEWAL_DURATION');
  assert.equal(JSON.parse(state.data).renews_order_id, serviceId);
  const prompt = textsTo(USER.id).at(-1) ?? '';
  assert.ok(prompt.includes('تمدید'));
  const buttons = buttonsTo(USER.id);
  assert.ok(buttons.includes('dur:30') && buttons.includes('dur:60') && buttons.includes('dur:90'));
  assert.ok(!buttons.includes('dur:custom'), 'renewal ladder has no custom option');

  // text input in the renewal duration step is refused (months only)
  stub.reset();
  await dispatch(messageUpdateAs(USER, '45', nextId()));
  state = sqlite
    .prepare('SELECT state FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER)) as { state: string };
  assert.equal(state.state, 'WAITING_RENEWAL_DURATION');
  assert.ok((textsTo(USER.id).at(-1) ?? '').includes(fa.renewDurationPrompt));

  // step back from duration → ladder restarts cleanly (IDLE + services)
  stub.reset();
  await dispatch(callbackUpdateAs('step:back', nextId(), USER, USER.id));
  await flush();
  state = sqlite
    .prepare('SELECT state FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER)) as { state: string } | undefined;
  assert.ok(state === undefined || state.state === 'IDLE', 'ladder exited');
  assert.ok((textsTo(USER.id).at(-1) ?? '').includes(fa.servicesHeader));

  // re-enter + choose 2 months: summary priced 2 × 120000
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('dur:60', nextId(), USER));
  const summary = textsTo(USER.id).at(-1) ?? '';
  assert.ok(summary.includes('۲ ماه'), 'month-label in summary');
  assert.ok(summary.includes('240000') || summary.includes('۲۴۰٬۰۰۰'), 'price shown');
  const token = JSON.parse(
    (
      sqlite.prepare('SELECT data FROM conversation_states WHERE customer_id = ?1')
        .get(customerIdOf(USER)) as { data: string }
    ).data,
  ).order_token as string;
  assert.ok(summary.includes(token));

  // forged non-preset duration → refused, ladder intact
  await dispatch(callbackUpdateAs('dur:45', nextId(), USER));
  state = sqlite
    .prepare('SELECT state FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf(USER)) as { state: string };
  assert.equal(state.state, 'WAITING_RENEWAL_CONFIRMATION');

  // confirm → durable renewal order, then the SHARED receipt pipeline
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const renewalRow = sqlite
    .prepare(`SELECT * FROM orders WHERE kind = 'renewal' ORDER BY created_at DESC LIMIT 1`)
    .get() as OrderRow;
  assert.ok(renewalRow, 'renewal order exists');
  assert.equal(renewalRow.state, 'pending_payment');
  assert.equal(renewalRow.renews_order_id, serviceId);
  assert.equal(renewalRow.amount, 240000);
  assert.equal(renewalRow.provision_attempts, 0);
  const snapshot = JSON.parse(renewalRow.selections) as Record<string, unknown>;
  assert.equal(snapshot['kind'], 'renewal');
  assert.equal(snapshot['renews_order_id'], serviceId);

  // replay protection: re-tapping confirm creates nothing new
  const ordersBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const ordersAfter = (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  assert.equal(ordersAfter, ordersBefore);

  stub.panel.reset();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'RNR_RECEIPT' }, USER));
  await dispatch(
    callbackUpdateAs(`adm:ok:${renewalRow.id}`, nextId(), ADMIN, ADMIN.id),
  );
  await flush();

  const puts = putCalls();
  assert.equal(puts.length, 1, 'exactly one modify call');
  assert.equal(puts[0]!.path, `/api/user/by-username/${username}`);
  assert.equal(puts[0]!.headers['x-api-key'], PANEL_KEY);
  assert.deepEqual(puts[0]!.body, { expire: expireBefore + 60 * DAY_SECONDS });
  assert.equal(users.get(username)!.expire, expireBefore + 60 * DAY_SECONDS);

  const applied = orderById(renewalRow.id)!;
  assert.equal(applied.state, 'completed');
  assert.equal(applied.renew_target_unix, expireBefore + 60 * DAY_SECONDS);
  assert.equal(applied.pasarguard_username, null, 'renewal owns no username');

  const svc = orderById(serviceId)!;
  assert.equal(svc.state, 'completed');
  assert.equal(svc.service_expires_at, new Date((expireBefore + 60 * DAY_SECONDS) * 1000).toISOString());
  assert.ok(eventsOf(serviceId).includes('service_extended'));
  assert.ok(eventsOf(renewalRow.id).includes('renewal_succeeded'));
  assert.ok(textsTo(USER.id).some((t) => t.includes('تمدید شد')));
});

test('ambiguous timeout is ADOPTED on retry — no second PUT, no double extension', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  const username = `pg${serviceId.toLowerCase()}`;
  scenario.putMode = 'ambiguous';
  stub.panel.reset();

  const first = orderById(serviceId)!.service_expires_at;
  const renewalId = await directRenewalOrder(serviceId, 90);
  const outcome = await provisionOrder(quietDeps, { orderId: renewalId });
  assert.equal(outcome.ok, false, 'apply reports failure (no 200 confirmation)');
  const failed = orderById(renewalId)!;
  assert.equal(failed.state, 'failed');
  const storedTarget = failed.renew_target_unix;
  assert.ok(storedTarget !== null);
  assert.equal(putCalls().length, 1, 'PUT was attempted exactly once');
  assert.equal(users.get(username)!.expire, storedTarget, 'the write actually LANDED panel-side');

  // admin retry: precheck sees expire >= target → adopt, never re-PUT
  scenario.putMode = 'ok';
  const retry = await provisionOrder(quietDeps, { orderId: renewalId, retry: true });
  assert.equal(retry.ok, true);
  assert.equal(putCalls().length, 1, 'still exactly one PUT across both attempts');
  assert.equal(orderById(renewalId)!.state, 'completed');
  assert.equal(
    orderById(serviceId)!.service_expires_at,
    new Date(Number(storedTarget) * 1000).toISOString(),
  );
  void first;
});

test('renewal attempts respect the shared cap; exhausted orders stay failed', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  scenario.putMode = 'fail500';
  stub.panel.reset();
  const renewalId = await directRenewalOrder(serviceId, 30);
  for (let i = 0; i < 3; i++) {
    const outcome = await provisionOrder(
      quietDeps,
      { orderId: renewalId, retry: i > 0 },
    );
    assert.equal(outcome.ok, false);
  }
  assert.equal(putCalls().length, 3);
  assert.equal(orderById(renewalId)!.provision_attempts, 3);
  const fourth = await provisionOrder(quietDeps, { orderId: renewalId, retry: true });
  assert.deepEqual(fourth, { ok: false, error: 'attempts_exhausted' });
  assert.equal(putCalls().length, 3, 'the cap blocks any further panel write');
  scenario.putMode = 'ok';
});

test('expired service renews from NOW; renewal doc unconfigured = zero writes', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  const username = `pg${serviceId.toLowerCase()}`;
  const renewalId = await directRenewalOrder(serviceId, 30);

  // simulate expiry: panel + local rows say the service lapsed a month ago
  const past = Math.floor(Date.now() / 1000) - 30 * DAY_SECONDS;
  users.get(username)!.expire = past;
  sqlite
    .prepare('UPDATE orders SET service_expires_at = ?1 WHERE id = ?2')
    .run(new Date(past * 1000).toISOString(), serviceId);
  stub.panel.reset();

  // panel config missing → skip with NO claim, NO write, NO network
  const savedKey = envRef.PASARGUARD_API_KEY;
  delete envRef.PASARGUARD_API_KEY;
  const skipped = await provisionOrder(quietDeps, { orderId: renewalId });
  assert.deepEqual(skipped, { ok: false, skip: 'unconfigured' });
  assert.equal(orderById(renewalId)!.state, 'approved');
  assert.equal(stub.panel.calls.length, 0);
  envRef.PASARGUARD_API_KEY = savedKey;

  const outcome = await provisionOrder(quietDeps, { orderId: renewalId });
  assert.equal(outcome.ok, true);
  const target = putCalls()[0]!.body!.expire as number;
  assert.ok(target >= Math.floor(Date.now() / 1000) + 29 * DAY_SECONDS, 'extended from now, not past');
  assert.equal(users.get(username)!.expire, target);
});

test('renewal with missing panel link fails sanely (no user on the panel)', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  const username = `pg${serviceId.toLowerCase()}`;
  const saved = users.get(username)!;
  users.delete(username);
  const renewalId = await directRenewalOrder(serviceId, 30);
  const outcome = await provisionOrder(quietDeps, { orderId: renewalId });
  assert.equal(outcome.ok, false);
  assert.equal(orderById(renewalId)!.state, 'failed');
  assert.equal(orderById(renewalId)!.failure_reason, 'renewal_service_missing');
  users.set(username, saved);
  scenario.putMode = 'ok';
});

test('a renewal can never touch another customer’s service via forged link', async () => {
  const serviceId = (
    sqlite.prepare(`SELECT id FROM orders WHERE kind = 'purchase' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
  ).id;
  // hand-craft a renewal order whose snapshot claims OUR service but is
  // owned by the OTHER customer, as if forged straight into D1:
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const price = calculateRenewalPrice(loaded.catalog.pricing, { durationDays: 30 });
  assert.equal(price.ok, true);
  if (!price.ok) return;
  const res = await checkoutRenewalOrder(
    db,
    {
      customerId: customerIdOf(OTHER),
      orderToken: newOrderId(),
      catalog: loaded.catalog,
      breakdown: price.breakdown,
      serviceOrderId: serviceId,
    },
    'forged',
  );
  assert.equal(res.ok, true);
  forceAwaitingReview(res.order.id);
  const approved = await approveOrderByAdmin(db, res.order.id, String(ADMIN.id));
  assert.equal(approved.ok, true);
  stub.panel.reset();
  const outcome = await provisionOrder(quietDeps, { orderId: res.order.id });
  assert.equal(outcome.ok, false);
  assert.equal(putCalls().length, 0, 'cross-owner link never reaches the panel');
  assert.equal(orderById(res.order.id)!.state, 'failed');
});
