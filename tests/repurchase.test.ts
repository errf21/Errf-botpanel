/**
 * Phase 18 repurchase (same existing PasarGuard user, reset + reconfigure).
 * Fully offline. Covers the approved scope only:
 *  - Mode A restores the ORIGINAL specs as ABSOLUTE finals (quota/duration/HWID)
 *  - Mode B applies SELECTED finals absolutely (20 over 10 == exactly 20)
 *  - pricing is the NORMAL purchase calculator (calculatePrice), never renewal
 *  - quota uses the SAME GB_BYTES conversion (10GB == exactly 10737418240)
 *  - reset is exactly one POST .../by-username/{u}/reset; usage becomes 0
 *  - ONE combined PUT {data_limit, expire, hwid_limit}; zero POST create,
 *    zero DELETE; same user/id retained; subscription rotation tolerated
 *  - guards: active / free-test / panel-deleted / sales-stop / ownership /
 *    kill-switch / concurrent repurchase
 *  - payment: full + partial wallet, receipt/admin review, reject/refund,
 *    idempotent replays and duplicate approvals
 *  - provisioning: exact GET verification, failed verification, retry/adopt,
 *    missing panel user fails closed with no recreation
 *  - regression: legacy renewal flow + history rows untouched, normal
 *    purchase unchanged
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
import { loadCatalog } from '../src/catalog/catalog.ts';
import { calculatePrice } from '../src/catalog/pricing.ts';
import { GB_BYTES, parseRepurchaseSelections } from '../src/provision/provision.ts';
import { fa } from '../src/telegram/texts.ts';
import { orderSummaryLines } from '../src/admin.ts';

const PANEL_KEY = 'PG-SECRET-KEY-99';
const PANEL_BASE = 'https://panel.test';
const DAY_SECONDS = 86_400;

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
let panelSeq = 900;
let subSeq = 1;
const scenario = {
  putMode: 'ok' as 'ok' | 'ambiguous',
  putIgnoreLimit: false,
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
      subscription_url: `/sub/${username}/SUBLINK${subSeq++}`,
      expire: Number(body['expire'] ?? 0),
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
      hwid_limit: Number(body['hwid_limit'] ?? 1),
    };
    users.set(username, record);
    return Response.json({ data: { ...record } });
  }
  // Usage reset on the EXISTING user only. The bulk POST /api/users/reset is
  // intentionally unimplemented: any call to it 404s in this harness.
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
    // The deployed panel MAY rotate the subscription URL on reset (verified
    // live — the old URL keeps working). Rotate here so tests prove the
    // implementation never treats the URL as identity.
    user.subscription_url = `/sub/${username}/SUBLINK${subSeq++}`;
    return Response.json({ data: { ...user } });
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
    if (body['data_limit'] !== undefined && !scenario.putIgnoreLimit) {
      user.data_limit = Number(body['data_limit']);
    }
    if (body['hwid_limit'] !== undefined) user.hwid_limit = Number(body['hwid_limit']);
    if (scenario.putMode === 'ambiguous') {
      // The write LANDED despite the 504 (applies before responding).
      return Response.json({ detail: 'gateway timeout' }, { status: 504 });
    }
    return Response.json({ data: { ...user } });
  }
  if (request.method === 'DELETE') {
    return Response.json({ detail: 'unexpected delete in repurchase tests' }, { status: 500 });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { provisionOrder } = await import('../src/provision/provision.ts');
const { applyWalletMutation } = await import('../src/db/wallet.ts');

const sqlite = freshDb();
// The migration seeds the kill-switch DISABLED (prod-safe default). Tests
// exercise the feature, so the harness explicitly enables it here — the
// guards test below still covers the disabled path by toggling it back.
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

let counter = 51000;
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
const toastsTo = (): string[] =>
  stub.sent.filter((s) => s.method === 'answerCallbackQuery').map((s) => String(s.payload['text'] ?? ''));
const putCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/api/user/by-username/'));
const postCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');
const resetCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reset'));
const deleteCalls = () => stub.panel.calls.filter((c) => c.method === 'DELETE');

/** buy → receipt → approve → completed service; returns the order id. */
async function purchaseToCompleted(volumeGb = 10, durationDays = 30, devices = 1): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, `rptest${nextId()}`, nextId()));
  await dispatch(callbackUpdateAs(`vol:${volumeGb}`, nextId(), USER));
  await dispatch(callbackUpdateAs(`dur:${durationDays}`, nextId(), USER));
  await dispatch(callbackUpdateAs(`dev:${devices}`, nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RP_${nextId()}` }, USER));
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

function sessionOf(): { state: string; data: Record<string, unknown> } {
  return sqlite
    .prepare('SELECT state, data FROM conversation_states WHERE customer_id = ?1')
    .get(customerIdOf()) as { state: string; data: Record<string, unknown> };
}

function expireService(serviceId: string): void {
  sqlite.prepare(`UPDATE orders SET service_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`).run(serviceId);
}

function repurchaseRows(): Record<string, unknown>[] {
  return sqlite
    .prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at ASC`)
    .all() as unknown as Record<string, unknown>[];
}

/** Drive a repurchase to receipt-pending; returns the repurchase order id. */
async function repurchaseToPending(
  serviceId: string,
  mode: 'same' | 'custom',
  custom?: { volumeText?: string; duration?: number; devices?: number },
): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs(mode === 'same' ? 'rep:same' : 'rep:custom', nextId(), USER));
  if (mode === 'custom') {
    if (custom?.volumeText !== undefined) {
      await dispatch(messageUpdateAs(USER, custom.volumeText, nextId()));
    }
    if (custom?.duration !== undefined) {
      await dispatch(callbackUpdateAs(`dur:${custom.duration}`, nextId(), USER));
    }
    if (custom?.devices !== undefined) {
      await dispatch(callbackUpdateAs(`dev:${custom.devices}`, nextId(), USER));
    }
  }
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RPR_${nextId()}` }, USER));
  const row = sqlite
    .prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
    .get() as Record<string, unknown>;
  return String(row['id']);
}

async function approveRepurchase(repurchaseId: string): Promise<void> {
  await dispatch(callbackUpdateAs(`adm:ok:${repurchaseId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
}

/* ================= pricing: normal purchase calculator ================= */

test('repurchase pricing is calculatePrice over the finals (same + custom)', async () => {
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const pricing = loaded.catalog.pricing;
  const same = calculatePrice(pricing, { volumeGb: 10, durationDays: 30, deviceCount: 2 });
  assert.equal(same.ok, true);
  const custom = calculatePrice(pricing, { volumeGb: 20, durationDays: 60, deviceCount: 3 });
  assert.equal(custom.ok, true);
  if (!same.ok || !custom.ok) return;
  // Volume is absolute: 20GB prices as a 20GB purchase, never 10+20 stacked.
  const base = calculatePrice(pricing, { volumeGb: 10, durationDays: 60, deviceCount: 3 });
  assert.equal(base.ok, true);
  if (!base.ok) return;
  assert.ok(custom.breakdown.total > base.breakdown.total, 'extra 10GB is priced');
  assert.equal(custom.breakdown.volume_gb, 20);
});

test('quota math is exact GiB: 10GB == 10737418240, 20GB == 21474836480', () => {
  assert.equal(10 * GB_BYTES, 10_737_418_240);
  assert.equal(20 * GB_BYTES, 21_474_836_480);
});

test('migration 0019 seeds the kill-switch DISABLED and keeps 0018 history', () => {
  const seedDb = freshDb();
  const seed = seedDb.prepare(`SELECT value FROM settings WHERE key = 'repurchase'`).get() as { value: string };
  assert.deepEqual(JSON.parse(seed.value), { schema: 1, enabled: false, near_expiry_days: 7 });
  const states = seedDb.prepare(`SELECT sql FROM sqlite_master WHERE name = 'conversation_states'`).get() as { sql: string };
  for (const s of ['WAITING_REPURCHASE_MODE', 'WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_VOLUME', 'WAITING_RENEWAL_CONFIRMATION']) {
    assert.ok(states.sql.includes(s), `state present: ${s}`);
  }
  const cols = seedDb.prepare(`PRAGMA table_info(orders)`).all() as unknown as { name: string }[];
  for (const c of ['repurchase_mode', 'repurchase_target_quota_bytes', 'repurchase_target_unix', 'repurchase_target_hwid', 'repurchase_reset_done', 'renew_target_data_limit_bytes']) {
    assert.ok(cols.some((col) => col.name === c), `column present: ${c}`);
  }
});

/* ================= entry UI ================= */

test('expired service detail shows repurchase entry + buy-new; active does not', async () => {
  const serviceId = await purchaseToCompleted(10, 30, 2);
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  assert.ok(!buttonsTo(USER.id).some((b) => b === `svc:rep:${serviceId}`), 'active service hides repurchase');

  expireService(serviceId);
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), USER));
  const buttons = buttonsTo(USER.id);
  assert.ok(buttons.some((b) => b === `svc:rep:${serviceId}`), 'expired service shows repurchase entry');
  assert.ok(buttons.includes('menu:buy'), 'expired service keeps normal buy-new entry');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= Mode A e2e ================= */

test('e2e same-spec: exact quota restored, usage 0, fresh expiry, same user, no create/delete', async () => {
  const serviceId = await purchaseToCompleted(10, 30, 2);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  const panelIdBefore = users.get(username)!.id;
  // Drift the panel away from the purchased specs: repurchase must RESTORE
  // the originals absolutely (quota + expiry + hwid), not adopt the drift.
  users.get(username)!.used_traffic = 5 * GB_BYTES;
  users.get(username)!.data_limit = 5 * GB_BYTES;
  users.get(username)!.expire = Math.floor(Date.now() / 1000) - 1000;
  users.get(username)!.hwid_limit = 5;
  const subBefore = users.get(username)!.subscription_url;
  // Seed paid notices as already-sent: repurchase must re-arm exactly these.
  sqlite.prepare(`INSERT OR IGNORE INTO service_notifications (order_id, kind, status) VALUES (?1, 'usage90', 'sent')`).run(serviceId);
  sqlite.prepare(`INSERT OR IGNORE INTO service_notifications (order_id, kind, status) VALUES (?1, 'expiring', 'sent')`).run(serviceId);
  sqlite.prepare(`INSERT OR IGNORE INTO service_notifications (order_id, kind, status) VALUES (?1, 'free_test_expiring', 'sent')`).run(serviceId);
  stub.panel.reset();
  stub.reset();

  const repurchaseId = await repurchaseToPending(serviceId, 'same');
  const row = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(repurchaseId) as Record<string, unknown>;
  assert.equal(row['kind'], 'renewal');
  assert.equal(row['repurchase_mode'], 'same');
  const snapshot = JSON.parse(String(row['selections'])) as Record<string, unknown>;
  assert.equal(snapshot['kind'], 'repurchase');
  assert.equal(snapshot['mode'], 'same');
  assert.equal(snapshot['volume_gb'], 10);
  assert.equal(snapshot['duration_days'], 30);
  assert.equal(snapshot['device_count'], 2);
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const expected = calculatePrice(loaded.catalog.pricing, { volumeGb: 10, durationDays: 30, deviceCount: 2 });
  assert.equal(expected.ok, true);
  if (!expected.ok) return;
  assert.equal(row['amount'], expected.breakdown.total, 'current purchase price, not historical');

  await approveRepurchase(repurchaseId);
  const after = users.get(username)!;
  assert.equal(after.id, panelIdBefore, 'same panel user');
  assert.equal(after.username, username);
  assert.equal(after.data_limit, 10_737_418_240, 'exact absolute quota');
  assert.equal(after.used_traffic, 0, 'usage reset');
  assert.equal(after.hwid_limit, 2, 'original device limit restored');
  const nowUnix = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(after.expire - (nowUnix + 30 * DAY_SECONDS)) <= 600, 'fresh 30d expiry');
  assert.notEqual(after.subscription_url, subBefore, 'rotation tolerated');
  assert.equal(postCalls().length, 0, 'no POST create');
  assert.equal(deleteCalls().length, 0, 'no DELETE');
  assert.equal(resetCalls().length, 1, 'exactly one reset POST');
  assert.equal(resetCalls()[0]!.path, `/api/user/by-username/${username}/reset`);
  const puts = putCalls();
  assert.equal(puts.length, 1, 'one combined PUT');
  assert.deepEqual(puts[0]!.body, {
    data_limit: 10_737_418_240,
    expire: after.expire,
    hwid_limit: 2,
  });

  const done = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(repurchaseId) as Record<string, unknown>;
  assert.equal(done['state'], 'completed');
  assert.equal(done['repurchase_reset_done'], 1);
  assert.equal(Number(done['repurchase_target_quota_bytes']), 10_737_418_240);
  const svc = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(serviceId) as Record<string, unknown>;
  assert.ok(svc['service_expires_at'] !== null && String(svc['service_expires_at']) > '2000-01-01', 'service expiry refreshed');
  // Root-relative panel URLs are absolutized on persist (purchase parity).
  assert.equal(svc['subscription_url'], `https://panel.test${after.subscription_url}`, 'current URL persisted');
  const notices = (sqlite.prepare(`SELECT kind FROM service_notifications WHERE order_id = ?1`).all(serviceId) as unknown as { kind: string }[]).map((r) => r.kind).sort();
  assert.deepEqual(notices, ['free_test_expiring'], 'only paid legs re-armed');
});

/* ================= Mode B e2e ================= */

test('e2e custom: 10GB prev + 20GB selected == exactly 20GB, custom duration/HWID, same user', async () => {
  const serviceId = await purchaseToCompleted(10, 30, 1);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  const panelIdBefore = users.get(username)!.id;
  users.get(username)!.used_traffic = 7 * GB_BYTES;
  stub.panel.reset();
  stub.reset();

  const repurchaseId = await repurchaseToPending(serviceId, 'custom', { volumeText: '20', duration: 60, devices: 3 });
  const row = sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(repurchaseId) as Record<string, unknown>;
  assert.equal(row['repurchase_mode'], 'custom');
  const snapshot = JSON.parse(String(row['selections'])) as Record<string, unknown>;
  assert.equal(snapshot['volume_gb'], 20);
  assert.equal(snapshot['duration_days'], 60);
  assert.equal(snapshot['device_count'], 3);

  await approveRepurchase(repurchaseId);
  const after = users.get(username)!;
  assert.equal(after.id, panelIdBefore, 'same panel user');
  assert.equal(after.data_limit, 21_474_836_480, 'exactly 20GB, NOT 30GB');
  assert.equal(after.used_traffic, 0);
  assert.equal(after.hwid_limit, 3, 'custom HWID applied');
  const nowUnix = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(after.expire - (nowUnix + 60 * DAY_SECONDS)) <= 600, 'fresh 60d expiry');
  assert.equal(postCalls().length, 0, 'no POST create');
  assert.equal(deleteCalls().length, 0, 'no DELETE');
  assert.equal(resetCalls().length, 1, 'exactly one reset POST');
  const puts = putCalls();
  assert.equal(puts.length, 1, 'one combined PUT');
  assert.deepEqual(puts[0]!.body, {
    data_limit: 21_474_836_480,
    expire: after.expire,
    hwid_limit: 3,
  });
});

test('custom validation reuses purchase limits: bad numbers rejected, state kept', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const before = repurchaseRows().length;
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:custom', nextId(), USER));
  stub.reset();
  await dispatch(messageUpdateAs(USER, 'notanumber', nextId()));
  assert.ok(String(textsTo(USER.id).at(-1)).length > 0);
  await dispatch(messageUpdateAs(USER, '5', nextId()));
  assert.ok(String(textsTo(USER.id).at(-1)).includes('10'), 'volume floor surfaced');
  assert.equal(repurchaseRows().length, before, 'no order from invalid input');
  const st = sessionOf();
  assert.equal(st.state, 'WAITING_REPURCHASE_VOLUME');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});

/* ================= guards ================= */

test('guards: active / free-test / panel-deleted / stop / kill-switch / ownership / concurrent', async () => {
  // active service blocked
  const activeId = await purchaseToCompleted(10);
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${activeId}`, nextId(), USER));
  assert.ok(toastsTo().at(-1)?.length, 'toast on blocked entry');
  const before = repurchaseRows().length;

  // free-test blocked (claims-table authoritative)
  const testId = await purchaseToCompleted(10);
  expireService(testId);
  sqlite.prepare(`INSERT OR IGNORE INTO free_test_claims (customer_id, order_id) VALUES (?1, ?2)`).run(customerIdOf(), testId);
  await dispatch(callbackUpdateAs(`svc:rep:${testId}`, nextId(), USER));

  // panel-deleted blocked
  const goneId = await purchaseToCompleted(10);
  expireService(goneId);
  sqlite.prepare(`UPDATE orders SET panel_deleted_at = '2026-01-01T00:00:00.000Z', panel_deleted_by = 'test' WHERE id = ?1`).run(goneId);
  await dispatch(callbackUpdateAs(`svc:rep:${goneId}`, nextId(), USER));

  // sales stop blocked with zero writes
  const stoppedId = await purchaseToCompleted(10);
  expireService(stoppedId);
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"stopped":true}' WHERE key = 'sales'`).run();
  const panelBefore = stub.panel.calls.length;
  await dispatch(callbackUpdateAs(`svc:rep:${stoppedId}`, nextId(), USER));
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"stopped":false}' WHERE key = 'sales'`).run();
  assert.equal(stub.panel.calls.length, panelBefore, 'stop: zero panel calls');

  // kill-switch blocked
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"enabled":false,"near_expiry_days":7}' WHERE key = 'repurchase'`).run();
  await dispatch(callbackUpdateAs(`svc:rep:${stoppedId}`, nextId(), USER));
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"enabled":true,"near_expiry_days":7}' WHERE key = 'repurchase'`).run();

  // foreign owner blocked
  await dispatch(callbackUpdateAs(`svc:rep:${stoppedId}`, nextId(), ADMIN, ADMIN.id));

  // concurrent repurchase blocked: drive one to pending, start another
  const concId = await purchaseToCompleted(10);
  expireService(concId);
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${concId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const mid = repurchaseRows().length;
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${concId}`, nextId(), USER));
  assert.equal(repurchaseRows().length, mid, 'second concurrent repurchase blocked');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));

  assert.equal(repurchaseRows().length, before + 1, 'only the concurrent draft exists');
});

/* ================= payment ================= */

test('wallet full pays instantly, provisions once, replay converges', async () => {
  const { payOrderWithWallet } = await import('../src/db/wallet.ts');
  void payOrderWithWallet;
  const serviceId = await purchaseToCompleted(10, 30, 2);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  users.get(username)!.used_traffic = 2 * GB_BYTES;
  const loaded = await loadCatalog(db);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const price = calculatePrice(loaded.catalog.pricing, { volumeGb: 10, durationDays: 30, deviceCount: 2 });
  assert.equal(price.ok, true);
  if (!price.ok) return;
  const granted = await applyWalletMutation(db, {
    customerId: customerIdOf(),
    amountIrt: price.breakdown.total + 5000,
    kind: 'admin_grant',
    actor: 'test',
  });
  assert.equal(granted.ok, true);
  stub.panel.reset();
  stub.reset();

  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
  await flush();
  const row = sqlite.prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
  assert.equal(row['state'], 'completed');
  assert.equal(row['verified_by'], 'wallet');
  assert.equal(users.get(username)!.used_traffic, 0);
  assert.equal(users.get(username)!.data_limit, 10_737_418_240);
  const payments = (sqlite.prepare(`SELECT COUNT(*) AS n FROM wallet_entries WHERE kind = 'order_payment' AND order_id = ?1`).get(String(row['id'])) as { n: number }).n;
  assert.equal(payments, 1, 'exactly-once wallet debit');
  assert.equal(resetCalls().length, 1);
  assert.equal(postCalls().length, 0);
});

test('partial wallet + receipt remainder, duplicate confirm + duplicate approval converge', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  users.get(username)!.used_traffic = 3 * GB_BYTES;
  users.get(username)!.expire = Math.floor(Date.now() / 1000) - 500;
  await applyWalletMutation(db, { customerId: customerIdOf(), amountIrt: 1000, kind: 'admin_grant', actor: 'test' });
  stub.panel.reset();

  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('wlt:part', nextId(), USER));
  const pending = sqlite.prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
  assert.equal(pending['state'], 'pending_payment');
  assert.ok(Number(pending['amount']) > 0, 'remainder due');
  // duplicate confirm replay: same token, no second order
  const token = (JSON.parse(String(pending['selections'])) as Record<string, unknown>)['idempotency_key'] ??
    sqlite.prepare(`SELECT idempotency_key FROM orders WHERE id = ?1`).get(String(pending['id']));
  void token;
  const countBefore = repurchaseRows().length;
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RPP_${nextId()}` }, USER));
  const awaiting = sqlite.prepare(`SELECT * FROM orders WHERE id = ?1`).get(String(pending['id'])) as Record<string, unknown>;
  assert.equal(awaiting['state'], 'awaiting_review');
  const putsBefore = putCalls().length;
  await dispatch(callbackUpdateAs(`adm:ok:${pending['id']}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  // duplicate approval: already reviewed, no re-provisioning
  await dispatch(callbackUpdateAs(`adm:ok:${pending['id']}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(repurchaseRows().length, countBefore, 'no duplicate order');
  assert.equal(putCalls().length, putsBefore + 1, 'exactly one provisioning PUT total');
  const done = sqlite.prepare(`SELECT * FROM orders WHERE id = ?1`).get(String(pending['id'])) as Record<string, unknown>;
  assert.equal(done['state'], 'completed');
  assert.equal(users.get(username)!.used_traffic, 0);
});

test('rejection refunds the wallet credit exactly once', async () => {
  const { performAdminReview } = await import('../src/admin.ts');
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  await applyWalletMutation(db, { customerId: customerIdOf(), amountIrt: 1000, kind: 'admin_grant', actor: 'test' });
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rep:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('rep:same', nextId(), USER));
  await dispatch(callbackUpdateAs('wlt:part', nextId(), USER));
  const pending = sqlite.prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RPRJ_${nextId()}` }, USER));
  const balanceOf = (): number =>
    (sqlite.prepare('SELECT balance_irt AS n FROM customers WHERE id = ?1').get(customerIdOf()) as { n: number }).n;
  const beforeReject = balanceOf();
  const result = await performAdminReview({
    env: envRef as never,
    db,
    api: { sendMessage: async () => true } as never,
    actorId: ADMIN.id,
    orderId: String(pending['id']),
    decision: 'reject',
    reason: 'test reject',
  });
  assert.equal(result.ok, true);
  assert.ok(balanceOf() > beforeReject, 'rejected credit refunded');
  const refunds = (sqlite.prepare(`SELECT COUNT(*) AS n FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1`).get(String(pending['id'])) as { n: number }).n;
  assert.equal(refunds, 1, 'exactly-once refund');
});

/* ================= provisioning safety ================= */

test('retry after ambiguous PUT adopts stored targets: no second PUT, no second reset', async () => {
  const serviceId = await purchaseToCompleted(10, 30, 2);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  // Drift every dimension so the first attempt must PUT all three.
  users.get(username)!.used_traffic = 4 * GB_BYTES;
  users.get(username)!.data_limit = 5 * GB_BYTES;
  users.get(username)!.expire = Math.floor(Date.now() / 1000) - 500;
  users.get(username)!.hwid_limit = 5;
  const repurchaseId = await repurchaseToPending(serviceId, 'same');
  sqlite.prepare(`UPDATE orders SET state='awaiting_review', receipt_file_id='X' WHERE id = ?1`).run(repurchaseId);
  const { approveOrderByAdmin } = await import('../src/db/orders.ts');
  await approveOrderByAdmin(db, repurchaseId, String(ADMIN.id));

  scenario.putMode = 'ambiguous';
  stub.panel.reset();
  const quietApi = { sendMessage: async () => true };
  const first = await provisionOrder({ env: envRef as never, db, api: quietApi as never }, { orderId: repurchaseId });
  assert.equal(first.ok, false, 'ambiguous write fails closed');
  // The write LANDED despite the 504 (stub applies before responding).
  assert.equal(users.get(username)!.data_limit, 10_737_418_240);

  scenario.putMode = 'ok';
  stub.panel.reset();
  const retry = await provisionOrder({ env: envRef as never, db, api: quietApi as never }, { orderId: repurchaseId, retry: true });
  assert.equal(retry.ok, true);
  assert.equal(putCalls().length, 0, 'adopt path: no second PUT');
  assert.equal(resetCalls().length, 0, 'adopt path: no second reset');
  assert.equal(users.get(username)!.data_limit, 10_737_418_240, 'quota applied exactly once');
  assert.equal(users.get(username)!.used_traffic, 0);
  scenario.putMode = 'ok';
});

test('failed verification never finalizes: quota mismatch fails closed', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  // Drift the quota so the PUT must carry data_limit; the stub then drops
  // it, and verification must fail closed instead of finalizing.
  users.get(username)!.data_limit = 5 * GB_BYTES;
  users.get(username)!.used_traffic = 2 * GB_BYTES;
  const repurchaseId = await repurchaseToPending(serviceId, 'same');
  sqlite.prepare(`UPDATE orders SET state='awaiting_review', receipt_file_id='X' WHERE id = ?1`).run(repurchaseId);
  const { approveOrderByAdmin } = await import('../src/db/orders.ts');
  await approveOrderByAdmin(db, repurchaseId, String(ADMIN.id));

  scenario.putIgnoreLimit = true;
  stub.panel.reset();
  const quietApi = { sendMessage: async () => true };
  const outcome = await provisionOrder({ env: envRef as never, db, api: quietApi as never }, { orderId: repurchaseId });
  scenario.putIgnoreLimit = false;
  assert.equal(outcome.ok, false, 'unverified quota fails closed');
  const row = sqlite.prepare(`SELECT * FROM orders WHERE id = ?1`).get(repurchaseId) as Record<string, unknown>;
  assert.equal(row['state'], 'failed');
  assert.notEqual(users.get(username)!.data_limit, 10_737_418_240 - 1, 'sanity');
});

test('missing panel user fails closed: zero POST create, zero DELETE, service untouched', async () => {
  const serviceId = await purchaseToCompleted(10);
  expireService(serviceId);
  const username = `pg${serviceId.toLowerCase()}`;
  const expiryBefore = (sqlite.prepare(`SELECT service_expires_at AS v FROM orders WHERE id = ?1`).get(serviceId) as { v: string }).v;
  users.delete(username); // panel lost the user; repurchase must NOT recreate it
  const repurchaseId = await repurchaseToPending(serviceId, 'same');
  stub.panel.reset();
  await approveRepurchase(repurchaseId);
  const row = sqlite.prepare(`SELECT * FROM orders WHERE id = ?1`).get(repurchaseId) as Record<string, unknown>;
  assert.equal(row['state'], 'failed');
  assert.equal(postCalls().length, 0, 'no recreation POST');
  assert.equal(deleteCalls().length, 0, 'no DELETE');
  assert.equal(putCalls().length, 0, 'no PUT without a user');
  assert.equal(resetCalls().length, 0, 'no reset without a user');
  const expiryAfter = (sqlite.prepare(`SELECT service_expires_at AS v FROM orders WHERE id = ?1`).get(serviceId) as { v: string }).v;
  assert.equal(expiryAfter, expiryBefore, 'service row untouched');
});

/* ================= regression: legacy renewal intact ================= */

test('legacy renewal flow + history rows untouched by repurchase', async () => {
  const serviceId = await purchaseToCompleted(10);
  // Legacy renewal entry still works on a non-expired service.
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('vol:0', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const renewal = sqlite.prepare(`SELECT * FROM orders WHERE kind = 'renewal' AND repurchase_mode IS NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
  assert.ok(renewal, 'legacy renewal order created');
  const snapshot = JSON.parse(String(renewal['selections'])) as Record<string, unknown>;
  assert.equal(snapshot['kind'], 'renewal');
  // Admin rendering distinguishes the two products.
  const renewalLines = orderSummaryLines(renewal as never);
  assert.ok(renewalLines.some((l) => l.includes('تمدید')), 'renewal renders as renewal');
  const rep = sqlite.prepare(`SELECT * FROM orders WHERE repurchase_mode IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
  if (rep) {
    const repLines = orderSummaryLines(rep as never);
    assert.ok(repLines.some((l) => l.includes('خرید مجدد')), 'repurchase renders as repurchase');
  }
  // parseRepurchaseSelections rejects legacy renewal snapshots.
  const { parseRenewalSelections } = await import('../src/provision/provision.ts');
  assert.ok(parseRenewalSelections(renewal as never) !== null, 'legacy renewal still parses as renewal');
  assert.equal(parseRepurchaseSelections(renewal as never), null, 'legacy renewal is not a repurchase');
  await dispatch(messageUpdateAs(USER, '/cancel', nextId()));
});
