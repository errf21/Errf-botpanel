/**
 * Phase 15 free-test suite: the one-time 100 MB / 1-day service.
 *
 * Covers, in order:
 *  1. the settings-doc parser + FAIL-CLOSED loader (vs the fail-open sales doc);
 *  2. migration 0014 integrity (claims table, seeded doc, notice-kind rebuild
 *     preserving every pre-existing row byte-for-byte);
 *  3. the claim flow e2e through the real dispatcher + panel stub: first-ever
 *     /start offer (main menu contract untouched), suppression rules, happy
 *     path (panel POST IN BYTES), re-tap, true concurrent race, confirmed
 *     failure release, crash-recovery rebuild, hostile replays;
 *  4. the notification-policy split — the four required regressions: paid
 *     behavior unchanged; a test never gets the paid set; the dedicated ~2h
 *     notice fires exactly once; repeated/overlapping sweeps never dupe.
 * Time control mirrors the Phase 9 suite: explicit sweep clocks, windows
 * moved via service_expires_at. No waitUntil is injected into dispatch calls,
 * so provisioning runs inline and completes before each tap returns.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
import { newOrderId } from '../src/lib/security.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PANEL_BASE = 'https://panel.test';

/* ————————————————————————————— panel stub ————————————————————————————— */

interface FakePanelUser {
  id: string;
  username: string;
  data_limit: number;
  used_traffic: number;
}

const users = new Map<string, FakePanelUser>();
const allPosts: PanelRequest[] = [];
let panelSeq = 500;

function panelRespond(request: PanelRequest): Response {
  if (request.method === 'POST' && request.path === '/api/user') allPosts.push(request);
  if (request.method === 'GET' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    return user
      ? Response.json({
          data: {
            ...user,
            status: 'active',
            subscription_url: `/sub/${username}/LINK`,
            expire: Math.floor(Date.now() / 1000) + DAY_MS / 1000,
          },
        })
      : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if (request.method === 'POST' && request.path === '/api/user') {
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    const record: FakePanelUser = {
      id: String(panelSeq++),
      username,
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
    };
    users.set(username, record);
    return Response.json({
      data: {
        ...record,
        status: String(body['status'] ?? 'active'),
        subscription_url: `/sub/${username}/LINK`,
        expire: Math.floor(Date.now() / 1000) + Number(body['expire_duration'] ?? 0),
      },
    });
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
  PASARGUARD_API_KEY: 'PG-TEST-KEY',
  PASARGUARD_PANEL_URL: PANEL_BASE,
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');
const { freeTestAvailable, parseFreeTestConfig } = await import('../src/catalog/freeTest.ts');

let counter = 940000;
const nextId = () => ++counter;
let uid = 955000000;
const freshUser = (username?: string): typeof USER =>
  ({ id: ++uid, first_name: 'Tester', username: username ?? `ft${counter}`, language_code: 'fa' }) as typeof USER;

const sends = () => stub.sent.filter((s) => s.method === 'sendMessage');
const textsTo = (chatId: number) =>
  sends().filter((s) => Number(s.payload['chat_id']) === chatId).map((s) => String(s.text));
const lastSend = () => sends().at(-1)!;
const inlineOf = (payload: Record<string, unknown>) =>
  (payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)
    ?.inline_keyboard ?? [];
const posts = () => stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');
const getsByTestUsername = (orderId: string) => {
  const row = sqlite.prepare('SELECT pasarguard_username AS u FROM orders WHERE id = ?1').get(orderId) as
    | { u: string | null }
    | undefined;
  const u = row?.u ?? null;
  return u === null ? [] : stub.panel.calls.filter((c) => c.method === 'GET' && c.path.includes(encodeURIComponent(u)));
};

const ordersOf = (tgId: number) =>
  sqlite
    .prepare(
      `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.telegram_user_id = ?1 ORDER BY o.created_at`,
    )
    .all(String(tgId)) as {
    id: string; state: string; kind: string; amount: number; verified_by: string | null; selections: string;
  }[];
const claimOf = (tgId: number) =>
  sqlite
    .prepare(
      `SELECT f.order_id FROM free_test_claims f
        JOIN customers c ON c.id = f.customer_id WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgId)) as { order_id: string } | undefined;
const noticeKinds = (orderId: string): { kind: string; status: string }[] =>
  (sqlite
    .prepare('SELECT kind, status FROM service_notifications WHERE order_id = ?1')
    .all(orderId) as { kind: string; status: string }[]).map((r) => ({ kind: r.kind, status: r.status }));
const count = (sql: string, ...args: unknown[]) =>
  Number((sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n);

function setFreeTestDoc(value: unknown): void {
  sqlite
    .prepare(`UPDATE settings SET value = ?1 WHERE key = 'free_test'`)
    .run(typeof value === 'string' ? value : JSON.stringify(value));
}
function setSalesDoc(stopped: boolean): void {
  sqlite
    .prepare(`UPDATE settings SET value = ?1 WHERE key = 'sales'`)
    .run(JSON.stringify({ schema: 1, stopped }));
}
function setExpiry(orderId: string, atMs: number): void {
  sqlite
    .prepare('UPDATE orders SET service_expires_at = ?2 WHERE id = ?1')
    .run(orderId, new Date(atMs).toISOString());
}

/**
 * Sweep isolation (same discipline as the Phase 9 suite's `retire()`): mark
 * the PAID kinds 'sent' for every OTHER completed purchase so a global sweep
 * only ever counts the service under test. Test-kind rows never pre-exist for
 * these orders (claims are empty for them), so they stay unaffected.
 */
function settleOtherPaidServices(keepOrderId: string): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO service_notifications (order_id, kind, status)
       SELECT o.id, k.kind, 'sent'
         FROM orders o
         CROSS JOIN (SELECT 'expiring' AS kind UNION ALL SELECT 'usage90') k
        WHERE o.state = 'completed' AND o.kind = 'purchase' AND o.id != ?1`,
    )
    .run(keepOrderId);
}

async function startAndClaim(user: typeof USER): Promise<string> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  const order = ordersOf(user.id)[0];
  assert.ok(order, 'one order created');
  assert.equal(order.state, 'completed', 'panel configured → provisions inline');
  return order.id;
}

/* ————— 1. parser + fail-closed loader ————— */

test('P15-01 the seeded settings doc parses to exactly the agreed business rule', () => {
  const loaded = sqlite.prepare(`SELECT value FROM settings WHERE key = 'free_test'`).get() as { value: string };
  const r = parseFreeTestConfig(JSON.parse(loaded.value));
  assert.ok(r.ok);
  assert.deepEqual(r.config, { enabled: true, volumeMb: 100, durationDays: 1, deviceCount: 1 });
});

test('P15-01b parser rejects hostile docs outright — fail closed, never guess', () => {
  const bad: unknown[] = [
    null, 7, 'x', [],
    { enabled: true },
    { schema: 2, enabled: true, volume_mb: 100, duration_days: 1, device_count: 1 },
    { schema: 1, volume_mb: 100, duration_days: 1, device_count: 1 },
    { schema: 1, enabled: 'yes', volume_mb: 100, duration_days: 1, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: 0, duration_days: 1, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: 2.5, duration_days: 1, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: '100', duration_days: 1, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: 100_001, duration_days: 1, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: 100, duration_days: 0, device_count: 1 },
    { schema: 1, enabled: true, volume_mb: 100, duration_days: 1, device_count: 10_001 },
  ];
  for (const doc of bad) assert.equal(parseFreeTestConfig(doc).ok, false, `must reject ${JSON.stringify(doc)}`);
  const off = parseFreeTestConfig({ schema: 1, enabled: false, volume_mb: 100, duration_days: 1, device_count: 1 });
  assert.ok(off.ok && off.config.enabled === false);
});

test('P15-01c loader: disabled or schema-invalid docs mean NOT available (fail-closed)', async () => {
  // NOTE: settings.value itself carries CHECK(json_valid()) — the loader's
  // unparseable-JSON branch is belt-and-braces defense, but the CHECK makes
  // it unreachable from D1, so the schema parser proves fail-closed instead.
  assert.ok((await freeTestAvailable(db)).ok);
  setFreeTestDoc({ schema: 1, enabled: false, volume_mb: 100, duration_days: 1, device_count: 1 });
  let r = await freeTestAvailable(db);
  assert.ok(!r.ok && r.error === 'free_test:disabled');
  setFreeTestDoc([1, 2, 3]);
  r = await freeTestAvailable(db);
  assert.ok(!r.ok && r.error === 'free_test:schema');
  setFreeTestDoc({ schema: 1, enabled: true, volume_mb: 100, duration_days: 1, device_count: 1 });
});

/* ————— 2. migration 0014 integrity ————— */

test('P15-02 the service_notifications rebuild preserves every pre-existing row byte-for-byte and adds the new kind', () => {
  const raw = new DatabaseSync(':memory:');
  const preFiles = [
    '0001_init.sql', '0002_phase2.sql', '0003_phase3.sql', '0004_phase4.sql', '0005_phase5.sql',
    '0006_phase6.sql', '0007_phase7.sql', '0008_phase8c.sql', '0009_phase9.sql', '0010_phase10.sql',
    '0011_pricing_model.sql', '0012_device_limit.sql', '0013_sales_switch.sql',
  ];
  for (const f of preFiles) raw.exec(readFileSync(`${here}../migrations/${f}`, 'utf8'));
  raw.exec(`INSERT INTO customers (telegram_user_id) VALUES ('700001');`);
  raw.exec(
    `INSERT INTO orders (id, customer_id, selections, amount) VALUES ('O1', 1, '{"volume_gb":10}', 45000);`,
  );
  raw.exec(
    `INSERT INTO service_notifications (order_id, kind, status, attempts, last_checked_at)
     VALUES ('O1','expiring','sent',2,NULL), ('O1','usage90','skipped',0,'2025-01-01T00:00:00Z');`,
  );
  const before = raw
    .prepare('SELECT order_id, kind, status, attempts, last_checked_at FROM service_notifications ORDER BY kind')
    .all();
  raw.exec(readFileSync(`${here}../migrations/0014_free_test.sql`, 'utf8'));
  const after = raw
    .prepare('SELECT order_id, kind, status, attempts, last_checked_at FROM service_notifications ORDER BY kind')
    .all();
  assert.deepEqual(after, before);
  // New kind admitted; unknown kind still rejected (CHECK survived the rename).
  raw.exec(`INSERT INTO service_notifications (order_id, kind) VALUES ('O1','free_test_expiring');`);
  assert.throws(() =>
    raw.exec(`INSERT INTO service_notifications (order_id, kind) VALUES ('O1','bogus_kind');`),
  );
  // Re-running 0014 is safe (INSERT OR IGNORE keeps the seeded doc; rebuild idempotent).
  raw.exec(readFileSync(`${here}../migrations/0014_free_test.sql`, 'utf8'));
  // Claims wall exists: second claim for the same customer is impossible on any engine.
  raw.exec(`INSERT INTO free_test_claims (customer_id, order_id) VALUES (1,'Z1');`);
  assert.throws(() => raw.exec(`INSERT INTO free_test_claims (customer_id, order_id) VALUES (1,'Z2');`));
});

/* ————— 3. claim flow ————— */

test('P15-03 first-ever /start carries the offer bubble; the menu contract is untouched', async () => {
  const user = freshUser();
  stub.reset();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  const bubbles = sends();
  assert.equal(bubbles.length, 2, 'welcome + dedicated offer');
  const menu = bubbles[0]!.payload['reply_markup'] as {
    keyboard: { text: string; style?: string }[][];
    resize_keyboard: boolean;
    is_persistent?: boolean;
    one_time_keyboard?: boolean;
  };
  assert.deepEqual(menu.keyboard.map((r) => r.length), [3, 2, 2, 3], 'pinned shape preserved');
  assert.deepEqual(
    menu.keyboard[0],
    [
      { text: fa.menuBuy, style: 'danger' },
      { text: fa.menuServices, style: 'primary' },
      { text: fa.menuWallet, style: 'success' },
    ],
    'styled trio intact as row 1',
  );
  assert.equal(menu.is_persistent, undefined);
  // Task 1: the pinned menu shape carries the one-time hide semantics too.
  assert.equal(menu.one_time_keyboard, true);
  const offer = bubbles[1]!;
  assert.ok(String(offer.text).includes('۱۰۰'), 'Persian digits for the seeded volume');
  assert.ok(String(offer.text).includes('تست'), 'fa copy names the free test');
  const offerKb = inlineOf(offer.payload);
  assert.equal(offerKb[0][0].callback_data, 'tst:claim');
  assert.ok(offerKb.some((row) => row.some((b) => b.callback_data === 'act:back_menu')));

  // A later /start for the same (unclaimed) newcomer gets exactly one bubble.
  stub.reset();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  assert.equal(sends().length, 1, 'first-ever only');
});

test('P15-04 claim: one order born approved, completed inline, panel POST in SI BYTES', async () => {
  const user = freshUser();
  stub.reset(); stub.panel.reset();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  assert.equal(claimOf(user.id), undefined, 'no claim yet — tap claims, not the view');
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));

  const order = ordersOf(user.id)[0]!;
  assert.equal(order.kind, 'purchase');
  assert.equal(order.state, 'completed');
  assert.equal(order.amount, 0);
  assert.equal(order.verified_by, 'free_test');
  assert.equal(claimOf(user.id)!.order_id, order.id, 'claim row anchors the order id');
  const snapshot = JSON.parse(order.selections) as Record<string, unknown>;
  assert.equal(snapshot['free_test'], true);
  assert.equal(snapshot['volume_gb'], undefined, 'GB never touched on the test path');

  const created = posts().filter((p) => p.body && String(p.body['note']) === `telbot:${order.id}`);
  assert.equal(created.length, 1);
  const body = created[0]!.body as Record<string, unknown>;
  assert.equal(body['data_limit'], 100_000_000, '100 MB as bytes');
  assert.equal(body['expire_duration'], 86_400, '1 day in seconds');
  assert.equal(body['hwid_limit'], 1);
  assert.deepEqual(body['group_ids'], [24, 25], 'provisioning groups respected');

  // The once-safe surfaces: no money, no ledger, no queue side effects.
  assert.equal(count('SELECT COUNT(*) AS n FROM wallet_entries'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM referral_rewards'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM payment_reminders WHERE order_id = ?', order.id), 0);
  const toasts = stub.sent.filter((s) => s.method === 'answerCallbackQuery');
  assert.ok(toasts.length >= 1);
  const msgs = textsTo(user.id);
  assert.ok(msgs.some((m) => m.includes('🎁')), 'creation ack carries the gift marker');
  assert.ok(msgs.some((m) => m.includes('/sub/') || m.includes('LINK') || m.includes('🌐')), 'serviceReady followed');
  // Expiry booked ~1 day out (allow the harness timing slop).
  const orderRow = sqlite.prepare('SELECT service_expires_at AS e, service_created_at AS c FROM orders WHERE id = ?1').get(order.id) as
    { e: string | null; c: string | null };
  assert.ok(orderRow.e && orderRow.c);
  assert.ok(Date.parse(orderRow.e) - Date.parse(orderRow.c) > 22 * HOUR_MS, 'expiry ≈ created + 1 day');
});

test('P15-05 re-taps after completion: one order, zero new panel creates, honest copy', async () => {
  const user = freshUser();
  stub.reset(); stub.panel.reset();
  const orderId = await startAndClaim(user);
  const initialPostCount = posts().length;
  stub.reset(); stub.panel.reset();
  for (let i = 0; i < 4; i++) await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  assert.equal(claimOf(user.id)!.order_id, orderId);
  assert.equal(ordersOf(user.id).length, 1);
  assert.equal(posts().length, 0, 'no re-create, no re-provision of a completed service');
  assert.ok(textsTo(user.id).some((m) => m.includes('فقط یک تست' ) || m.includes('مصرف شده')), 'already-claimed copy');
  void initialPostCount;
});

test('P15-06 three concurrent claim taps: one claim, one order, one panel create', async () => {
  const user = freshUser();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  stub.reset(); stub.panel.reset();
  await Promise.all([
    dispatch(callbackUpdateAs('tst:claim', nextId(), user)),
    dispatch(callbackUpdateAs('tst:claim', nextId(), user)),
    dispatch(callbackUpdateAs('tst:claim', nextId(), user)),
  ]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get()['n'] >= 1, true);
  const orders = ordersOf(user.id);
  assert.equal(orders.length, 1, 'exactly one order');
  assert.equal(orders[0]!.state, 'completed', 'the provision claims converge');
  assert.equal(claimOf(user.id)!.order_id, orders[0]!.id);
  assert.equal(
    posts().filter((p) => (p.body?.['note'] ?? '') === `telbot:${orders[0]!.id}`).length,
    1,
    'panel saw exactly one create for this order',
  );
});

test('P15-07 confirmed order-insert failure releases only a fresh claim; the user can retry', async () => {
  const user = freshUser();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  stub.reset();
  // Force the atomic (order + event) batch to roll back:
  sqlite.exec(
    `CREATE TRIGGER break_event AFTER INSERT ON order_events
     BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;`,
  );
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  sqlite.exec('DROP TRIGGER break_event');
  assert.equal(claimOf(user.id), undefined, 'fresh claim released for a confirmed failure');
  assert.equal(ordersOf(user.id).length, 0);
  assert.ok(
    stub.sent.some((s) => s.method === 'answerCallbackQuery' && String(s.text).includes('فعلاً')),
    'failure answered honestly (alert toast)',
  );
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  assert.equal(ordersOf(user.id).length, 1, 'the retry claims for real');
  assert.equal(ordersOf(user.id)[0]!.state, 'completed');
});

test('P15-08 crash recovery: claim without an order rebuilds under the SAME id, once', async () => {
  const user = freshUser();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  const cid = sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(user.id)) as { id: number };
  const fakeId = newOrderId(); // a real ULID anchor (provisioning validates id shape)
  sqlite.prepare('INSERT INTO free_test_claims (customer_id, order_id) VALUES (?1, ?2)').run(cid.id, fakeId);
  assert.equal(ordersOf(user.id).length, 0, 'simulated crash window');

  stub.reset(); stub.panel.reset();
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  const orders = ordersOf(user.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, fakeId, 'rebuilt under the stored id — the order PK dedupes retried rebuilds');
  assert.equal(orders[0].state, 'completed');
  assert.equal(posts().length, 1);

  // A second tap stays on the settled path (no duplicate, no re-create).
  stub.reset(); stub.panel.reset();
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
  assert.equal(ordersOf(user.id).length, 1);
  assert.equal(posts().length, 0);

  // A forged claim id of ANOTHER customer never reaches the rebuild path:
  // claimOf() is keyed on the acting customer, so the pre-existing claim row
  // under customer A must not answer to customer B at all.
  const other = freshUser();
  await dispatch(messageUpdateAs(other, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('tst:claim', nextId(), other));
  assert.notEqual(ordersOf(other.id)[0].id, fakeId, 'B cannot adopt A claim — B gets its own id');
});

test('P15-09 gates: disabled/garbage docs hide offers AND refuse direct taps; the sales stop blocks the claim with zero writes', async () => {
  try {
    setFreeTestDoc({ schema: 1, enabled: false, volume_mb: 100, duration_days: 1, device_count: 1 });
    let user = freshUser();
    stub.reset();
    await dispatch(messageUpdateAs(user, '/start', nextId()));
    assert.equal(sends().length, 1, 'disabled → no offer bubble');
    await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
    assert.equal(claimOf(user.id), undefined, 'disabled tap never consumes the once-ever wall');
    setFreeTestDoc({ schema: 7 });
    user = freshUser();
    stub.reset();
    await dispatch(messageUpdateAs(user, '/start', nextId()));
    assert.equal(sends().length, 1, 'schema-garbage doc behaves like disabled');
    await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
    assert.equal(claimOf(user.id), undefined, 'garbage doc rejects direct taps too');
    setFreeTestDoc({ schema: 1, enabled: true, volume_mb: 100, duration_days: 1, device_count: 1 });

    user = freshUser();
    setSalesDoc(true);
    stub.reset();
    await dispatch(messageUpdateAs(user, '/start', nextId()));
    assert.equal(sends().length, 1, 'stop hides the offer');
    stub.reset();
    await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
    assert.ok(String(lastSend().text).includes('🛑'), 'stop answered with the standard notice');
    assert.equal(claimOf(user.id), undefined, 'a stopped tap burns nothing');
    setSalesDoc(false);
    await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
    assert.equal(claimOf(user.id)!.order_id, ordersOf(user.id)[0].id, 'after resume the tap claims for real');
  } finally {
    setFreeTestDoc({ schema: 1, enabled: true, volume_mb: 100, duration_days: 1, device_count: 1 });
    setSalesDoc(false);
  }
});

test('P15-10 My Services empty-state CTA, MB detail, hidden-and-refused renewal', async () => {
  const user = freshUser();
  stub.reset();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(messageUpdateAs(user, fa.menuServices, nextId()));
  let empty = lastSend();
  // First tap of services from IDLE: offer appended when eligible.
  assert.ok(String(empty.text).includes('هنوز سرویس فعالی نداری'), 'paid empty copy untouched');
  assert.ok(String(empty.text).includes('تست'), 'free-test CTA line appended');
  assert.ok(inlineOf(empty.payload).flat().some((b) => b.callback_data === 'tst:claim'), 'CTA keyboard present');

  const orderId = await startAndClaim(user);
  stub.reset();
  await dispatch(messageUpdateAs(user, fa.menuServices, nextId()));
  const listText = String(lastSend().text);
  assert.ok(!listText.includes('تست'), 'offer fully suppressed once claimed');
  assert.ok(listText.includes(fa.servicesHeader), 'services list renders normally');

  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${orderId}`, nextId(), user));
  const detail = lastSend();
  assert.ok(String(detail.text).includes('مگابایت'), 'the volume line is MB-labelled');
  assert.ok(String(detail.text).includes('100 مگابایت'), 'digits follow the summaryVolume display convention');
  assert.ok(!String(detail.text).includes('گیگ'), 'no GB unit on a test detail');
  const btns = inlineOf(detail.payload).flat();
  assert.ok(!btns.some((b) => String(b.callback_data ?? '').startsWith('svc:rnw')), 'no renew affordance');
  assert.ok(btns.some((b) => String(b.callback_data ?? '').startsWith('svc:ref')), 'refresh stays');

  // Forged renew tap: server-side guard (claims table) refuses BEFORE any write.
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${orderId}`, nextId(), user));
  const answers = stub.sent.filter((s) => s.method === 'answerCallbackQuery');
  assert.ok(answers.length >= 1);
  assert.ok(
    stub.sent.some((s) => String(s.text).includes('قابل تمدید نیست') || (s.payload['text'] ?? '').toString().includes('قابل تمدید نیست')),
    'renewNotForFreeTest surfaced',
  );
  assert.equal(ordersOf(user.id).length, 1, 'no renewal order was created');

  // A PAID service still shows GB + renew — the class split is complete.
  const paid = freshUser();
  await dispatch(messageUpdateAs(paid, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), paid));
  await dispatch(messageUpdateAs(paid, 'amber forest relay grid', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), paid));
  await dispatch(callbackUpdateAs('dur:30', nextId(), paid));
  await dispatch(callbackUpdateAs('dev:1', nextId(), paid));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), paid));
  const draft = ordersOf(paid.id)[0];
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'rc-1' }, paid));
  await dispatch(callbackUpdateAs(`adm:ok:${draft.id}`, nextId(), ADMIN, ADMIN.id));
  const paidId = ordersOf(paid.id)[0].id;
  assert.equal(ordersOf(paid.id)[0].state, 'completed');
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${paidId}`, nextId(), paid));
  const paidDetail = String(lastSend().text);
  assert.ok(paidDetail.includes('گیگابایت'), 'paid keeps the GB line');
  assert.ok(!paidDetail.includes('مگابایت'), 'GB detail never leaks MB copy');
  assert.ok(
    inlineOf(lastSend().payload).flat().some((b) => String(b.callback_data ?? '').startsWith('svc:rnw')),
    'renew button intact for paid',
  );
});

/* ————— 4. notification policy ————— */

test('P15-11 proof#1: paid legs fire EXACTLY as before for a paid service', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, 'winter ridge relay grid', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  await dispatch(callbackUpdateAs('dev:1', nextId(), user));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  const draft = ordersOf(user.id)[0];
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'rc-2' }, user));
  await dispatch(callbackUpdateAs(`adm:ok:${draft.id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(ordersOf(user.id)[0].state, 'completed');
  const orderId = ordersOf(user.id)[0].id;
  stub.reset();

  const nowMs = Date.now();
  const nowIso = (ms: number) => new Date(ms).toISOString();
  // 26h out: INSIDE the paid 3-day window, OUTSIDE the test 2h window.
  setExpiry(orderId, nowMs + 26 * HOUR_MS);
  settleOtherPaidServices(orderId);
  const r = await runServiceNotificationSweep(env, nowMs);
  assert.equal(r.expirySent, 1, 'paid expiry still fires');
  assert.equal(r.freeTestSent, 0, 'and NEVER the test kind');
  const kinds = noticeKinds(orderId).map((k) => k.kind);
  assert.ok(kinds.includes('expiring'), 'the paid kind is the one birthed');
  assert.ok(!kinds.includes('free_test_expiring'), 'no test row for paid services, ever');
  assert.ok(textsTo(user.id).some((m) => m.includes('انقضا')), 'existing paid expiry copy fired');

  // The usage leg also still works for paid services: push usage over 90%
  // and re-sweep just past the 60-min backoff stamp.
  const username = (
    sqlite.prepare('SELECT pasarguard_username AS u FROM orders WHERE id = ?1').get(orderId) as {
      u: string | null;
    }
  ).u;
  assert.ok(username, 'paid service is linked on the panel');
  const fake = users.get(username);
  assert.ok(fake, 'panel user exists for the paid service');
  fake.used_traffic = Math.floor((fake.data_limit ?? 0) * 0.9);
  const stamp = nowIso(nowMs - 61 * MIN);
  sqlite
    .prepare(`UPDATE service_notifications SET last_checked_at = ?2 WHERE order_id = ?1 AND kind = 'usage90'`)
    .run(orderId, stamp);
  const r2 = await runServiceNotificationSweep(env, nowMs + 61 * MIN);
  assert.equal(r2.usageSent, 1, 'usage90 still fires for paid services');
  assert.equal(r2.freeTestSent, 0);
});

test('P15-12 proofs#2/#3/#4: paid legs ignore a test; its 2h notice fires once; no dupes ever', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderId);

  let now = Date.now();
  let expires = now + 3 * HOUR_MS;
  setExpiry(orderId, expires);
  let r = await runServiceNotificationSweep(env, now);
  assert.equal(r.expirySent, 0, 'paid expiry ignores a claimed order (window overlap deliberate)');
  assert.equal(r.usageSent, 0, 'paid usage ignores a claimed order too');
  assert.equal(r.freeTestSent, 0, '3h out is still too early');
  assert.equal(noticeKinds(orderId).length, 0, 'no row birthed before the window');
  assert.equal(getsByTestUsername(orderId).length, 0, 'never enters panel polling');

  expires = now + 2 * HOUR_MS - 60_000; // firmly inside the window (slack included)
  setExpiry(orderId, expires);
  r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 1, 'exactly one dedicated notice');
  assert.equal(r.expirySent + r.usageSent, 0);
  assert.deepEqual(
    noticeKinds(orderId),
    [{ kind: 'free_test_expiring', status: 'sent' }],
    'settled terminal row, test kind only',
  );
  const copy = textsTo(user.id).find((m) => m.includes('⏳'))!;
  assert.ok(copy.includes('درود زیبا'), 'standalone notice persona rule');
  assert.ok(copy.includes('تست'), 'copy names the test');
  assert.ok(!/گیگ/.test(copy), 'unit-honest: no GB phrasing on a test notice');
  assert.equal(getsByTestUsername(orderId).length, 0, 'still zero usage GETs for the test');

  // proof#4: replay at the same instant, in-window, past expiry → nothing, ever.
  r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 0);
  r = await runServiceNotificationSweep(env, now + HOUR_MS);
  assert.equal(r.freeTestSent, 0);
  r = await runServiceNotificationSweep(env, expires + MIN);
  assert.equal(r.freeTestSent, 0, 'after expiry: the missed-window rule stays');
  assert.equal(noticeKinds(orderId).length, 1, 'a single row forever');
});

const MIN = 60_000;

test('P15-13 overlapping sweeps: one winner for the test notice alone', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  stub.reset();
  const now = Date.now();
  setExpiry(orderId, now + HOUR_MS);
  const [a, b] = await Promise.all([
    runServiceNotificationSweep(env, now),
    runServiceNotificationSweep(env, now + 1_000),
  ]);
  assert.equal(a.freeTestSent + b.freeTestSent, 1);
});

test('P15-14 the notice follows the recipient language', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  sqlite.prepare(`UPDATE customers SET language = 'en' WHERE telegram_user_id = ?1`).run(String(user.id));
  stub.reset();
  const now = Date.now();
  setExpiry(orderId, now + 90 * MIN);
  const r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 1);
  const en = textsTo(user.id).find((m) => m.includes('⏳'))!;
  assert.ok(/free test/i.test(en), 'English copy names the test');
  assert.ok(!/[\u0600-\u06FF]/.test(en), 'no Persian leaks into the English notice');
});
