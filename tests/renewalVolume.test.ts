/**
 * Renewal / service-increase — fully offline. The renewal UI ladder is
 * RETIRED (Phase 19: repurchase replaced it for every paid service), so this
 * file now covers what remains true:
 *  - pricing reuses the purchase rate (volumeExtraCost parity)
 *  - quota delta reuses the purchase GB_BYTES conversion (parity)
 *  - no renewal order is creatable from any UI path (retired entry/steps)
 *  - already-created (in-flight) renewal orders still finish via direct
 *    checkout + provisioning: retry/idempotency never double-adds quota
 *  - paid service detail offers repurchase, never a renewal button
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  TEST_CARD,
  USER,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  mediaUpdate,
  messageUpdateAs,
  type PanelRequest,
} from './helpers.ts';
import { loadCatalog, acceptVolume } from '../src/catalog/catalog.ts';
import { calculatePrice, calculateRenewalPrice, volumeExtraCost } from '../src/catalog/pricing.ts';
import { GB_BYTES, quotaDeltaBytesForAddedGb } from '../src/provision/provision.ts';
import { fa } from '../src/telegram/texts.ts';

const PANEL_KEY = 'PG-SECRET-KEY-77';
const PANEL_BASE = 'https://panel.test';

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
let panelSeq = 500;
const scenario = { putMode: 'ok' as 'ok' | 'ambiguous' };

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
  if (request.method === 'PUT' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    if (!user) return Response.json({ detail: 'Not Found' }, { status: 404 });
    const body = request.body ?? {};
    // used_traffic must never arrive on the wire — loud failure if it does.
    if ('used_traffic' in body || 'usedTraffic' in body) {
      return Response.json({ detail: 'used_traffic forbidden' }, { status: 400 });
    }
    if (body['expire'] !== undefined) user.expire = Number(body['expire']);
    if (body['data_limit'] !== undefined) user.data_limit = Number(body['data_limit']);
    if (scenario.putMode === 'ambiguous') {
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
  PAYMENT_CARD_NUMBER: TEST_CARD,
};
const env = envRef as unknown as Parameters<typeof processTelegramUpdate>[1];

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};

let counter = 31000;
const nextId = () => ++counter;

const textsTo = (chatId: number): string[] =>
  stub.sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
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

/** buy → receipt → approve → completed service; returns the order id. */
async function purchaseToCompleted(volumeGb = 10): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, `voltest${nextId()}`, nextId()));
  await dispatch(callbackUpdateAs(`vol:${volumeGb}`, nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:1', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RV_${nextId()}` }, USER));
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

function customerIdOf(): number {
  return (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(USER.id)) as { id: number }).id;
}

/** Directly create + approve a renewal order for tests (bypass UI — the UI
 *  ladder is retired; this covers the in-flight finish path only). */
async function directRenewalOrder(serviceId: string, days: number, addedGb: number): Promise<string> {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error('catalog');
  const { calculateRenewalPrice: calcRenew } = await import('../src/catalog/pricing.ts');
  const computed = calcRenew(loaded.catalog.pricing, { durationDays: days, addedVolumeGb: addedGb });
  assert.equal(computed.ok, true);
  if (!computed.ok) throw new Error('price');
  const { checkoutRenewalOrder } = await import('../src/orders/checkout.ts');
  const { newOrderId } = await import('../src/lib/security.ts');
  const result = await checkoutRenewalOrder(
    db,
    {
      customerId: customerIdOf(),
      orderToken: newOrderId(),
      catalog: loaded.catalog,
      breakdown: computed.breakdown,
      serviceOrderId: serviceId,
    },
    'direct-cfg',
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('checkout');
  return result.order.id;
}

async function approveRenewal(renewalId: string): Promise<void> {
  const sqliteAny = sqlite;
  sqliteAny.prepare(`UPDATE orders SET state='awaiting_review', receipt_file_id='X' WHERE id = ?1`).run(renewalId);
  await dispatch(callbackUpdateAs(`adm:ok:${renewalId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
}

/* ================= pricing parity: same rate as purchase ================= */

test('volumeExtraCost matches the purchase volume component for 10/20/30 + custom', async () => {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const pricing = loaded.catalog.pricing;
  for (const n of [10, 20, 30, 15]) {
    const shared = volumeExtraCost(pricing, n);
    assert.equal(shared.ok, true);
    if (!shared.ok) continue;
    // Purchase marginal: volume 10+N (1mo/1user) carries exactly N * rate.
    const purchase = calculatePrice(pricing, { volumeGb: 10 + n, durationDays: 30, deviceCount: 1 });
    assert.equal(purchase.ok, true);
    if (!purchase.ok) continue;
    assert.equal(shared.cost, n * pricing.pricePerGb);
    assert.equal(purchase.breakdown.volume_cost, shared.cost);
    // Renewal add-on totals reuse the same component.
    const renewal = calculateRenewalPrice(pricing, { durationDays: 0, addedVolumeGb: n });
    assert.equal(renewal.ok, true);
    if (!renewal.ok) continue;
    assert.equal(renewal.breakdown.volume_cost, shared.cost);
    assert.equal(renewal.breakdown.total, shared.cost);
  }
});

test('renewal pricing combos: duration-only legacy, volume-only, both; empty rejected', async () => {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const pricing = loaded.catalog.pricing;
  // Legacy duration-only totals unchanged (base 45000 / 80000 / 110000).
  for (const [days, total] of [[30, 45000], [60, 80000], [90, 110000]] as const) {
    const r = calculateRenewalPrice(pricing, { durationDays: days });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.breakdown.total, total);
  }
  // Volume-only: time 0, e.g. +20GB = 20 * rate.
  const v20 = calculateRenewalPrice(pricing, { durationDays: 0, addedVolumeGb: 20 });
  assert.equal(v20.ok, true);
  if (v20.ok) {
    assert.equal(v20.breakdown.time_cost, 0);
    assert.equal(v20.breakdown.volume_cost, 20 * pricing.pricePerGb);
    assert.equal(v20.breakdown.total, 20 * pricing.pricePerGb);
  }
  // Both: 1mo + 10GB = 45000 + 10 * rate.
  const both = calculateRenewalPrice(pricing, { durationDays: 30, addedVolumeGb: 10 });
  assert.equal(both.ok, true);
  if (both.ok) assert.equal(both.breakdown.total, 45000 + 10 * pricing.pricePerGb);
  // Empty / hostile rejected.
  assert.equal(calculateRenewalPrice(pricing, { durationDays: 0, addedVolumeGb: 0 }).ok, false);
  assert.equal(calculateRenewalPrice(pricing, { durationDays: 45, addedVolumeGb: 0 }).ok, false);
  assert.equal(calculateRenewalPrice(pricing, { durationDays: 120 }).ok, false);
});

/* ================= quota parity: same bytes as purchase ================= */

test('quota delta parity: renewal +N GB == purchase N GB data_limit (10/20/30 + custom)', () => {
  for (const n of [10, 20, 30, 15]) {
    assert.equal(quotaDeltaBytesForAddedGb(n), n * GB_BYTES);
  }
  assert.equal(quotaDeltaBytesForAddedGb(10), 10_737_418_240);
  assert.equal(quotaDeltaBytesForAddedGb(20), 21_474_836_480);
  assert.equal(quotaDeltaBytesForAddedGb(30), 32_212_254_720);
});

/* ================= validation: purchase limits reused ================= */

test('renewal custom volume reuses purchase limits: 5/9 reject, 10+ accept', async () => {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(acceptVolume(loaded.catalog, 5).ok, false);
  assert.equal(acceptVolume(loaded.catalog, 9).ok, false);
  assert.equal(acceptVolume(loaded.catalog, 10).ok, true);
  assert.equal(acceptVolume(loaded.catalog, 20).ok, true);
  assert.equal(acceptVolume(loaded.catalog, 501).ok, false);
});

/* ================= retired: no renewal order from any UI path ================= */

test('retired renewal UI creates zero orders across all dimensions', async () => {
  const serviceId = await purchaseToCompleted(10);
  const ordersBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;

  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  const entryToast = stub.sent.find((s) => s.method === 'answerCallbackQuery');
  assert.equal(String(entryToast?.payload['text']), fa.renewRetiredNotice);
  // every legacy ladder tap is a dead end from here
  await dispatch(callbackUpdateAs('dur:60', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:0', nextId(), USER));
  await dispatch(callbackUpdateAs('vol:20', nextId(), USER));
  await dispatch(callbackUpdateAs('vol:0', nextId(), USER));
  await dispatch(callbackUpdateAs('vol:custom', nextId(), USER));
  await dispatch(messageUpdateAs(USER, '15', nextId()));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
  const ordersAfter = (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  assert.equal(ordersAfter, ordersBefore, 'retired ladder creates nothing');
  const renewals = (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM orders WHERE kind = 'renewal' AND repurchase_mode IS NULL`).get() as {
      n: number;
    }
  ).n;
  assert.equal(renewals, 0, 'zero legacy renewal rows from UI');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= retry: never double-add ================= */

test('retry after ambiguous PUT adopts stored quota target instead of re-adding', async () => {
  const serviceId = await purchaseToCompleted(50);
  const username = `pg${serviceId.toLowerCase()}`;
  const baseLimit = users.get(username)!.data_limit;
  stub.panel.reset();

  // in-flight finish path only: the order is created directly (UI retired).
  // NOTE: approve WITHOUT provisioning (direct db call, like the legacy
  // test) so the ambiguous first attempt below is genuinely first.
  const renewalId = await directRenewalOrder(serviceId, 0, 20);
  sqlite.prepare(`UPDATE orders SET state='awaiting_review', receipt_file_id='X' WHERE id = ?1`).run(renewalId);
  const { approveOrderByAdmin } = await import('../src/db/orders.ts');
  await approveOrderByAdmin(db, renewalId, String(ADMIN.id));

  scenario.putMode = 'ambiguous';
  const quietApi = { sendMessage: async () => true };
  const first = await provisionOrder({ env: envRef as never, db, api: quietApi as never }, { orderId: renewalId });
  assert.equal(first.ok, false, 'ambiguous write fails closed');
  // The write LANDED despite the 504 (stub applies before responding).
  assert.equal(users.get(username)!.data_limit, baseLimit + 20 * GB_BYTES);

  scenario.putMode = 'ok';
  stub.panel.reset();
  const retry = await provisionOrder({ env: envRef as never, db, api: quietApi as never }, { orderId: renewalId, retry: true });
  assert.equal(retry.ok, true);
  assert.equal(putCalls().length, 0, 'adopt path: no second PUT');
  assert.equal(users.get(username)!.data_limit, baseLimit + 20 * GB_BYTES, 'quota applied exactly once');
  scenario.putMode = 'ok';
});

/* ================= retired UI: repurchase entry instead ================= */

test('paid service detail offers repurchase, never renewal', async () => {
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"enabled":true,"near_expiry_days":7}' WHERE key = 'repurchase'`).run();
  const serviceId = await purchaseToCompleted(10);
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  const detail = textsTo(USER.id).at(-1) ?? '';
  assert.ok(detail.length > 0);
  assert.ok(buttonsTo(USER.id).some((b) => b === `svc:rep:${serviceId}`), 'repurchase entry offered');
  assert.ok(!buttonsTo(USER.id).some((b) => String(b ?? '').startsWith('svc:rnw:')), 'no renewal button anywhere');
});
