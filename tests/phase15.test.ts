/**
 * Phase 15 free-test suite: the one-time 100 MB / 1-day service.
 *
 * Covers, in order:
 *  1. the settings-doc parser + FAIL-CLOSED loader (vs the fail-open sales doc);
 *  2. migration 0014 integrity (claims table, seeded doc, notice-kind rebuild
 *     preserving every pre-existing row byte-for-byte);
 *  3. the claim flow e2e through the real dispatcher + panel stub: first-ever
 *     /start offer (main menu contract untouched), suppression rules, happy
 *     path (panel POST with an ABSOLUTE expire + the exact MB byte cap),
 *     re-tap, true concurrent race, confirmed failure release,
 *     crash-recovery rebuild, hostile replays;
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
  /** Absolute unix seconds (0 = the panel's Unlimited marker). */
  expire: number;
}

const users = new Map<string, FakePanelUser>();
let panelSeq = 500;

function panelRespond(request: PanelRequest): Response {
  if (request.method === 'GET' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    return user
      ? Response.json({
          data: {
            ...user,
            status: 'active',
            subscription_url: `/sub/${username}/LINK`,
          },
        })
      : Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  if (request.method === 'POST' && request.path === '/api/user') {
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    // Production contract (2026-09): create honors the ABSOLUTE `expire`
    // (unix seconds) — the relative `expire_duration` is ignored.
    const record: FakePanelUser = {
      id: String(panelSeq++),
      username,
      data_limit: Number(body['data_limit'] ?? 0),
      used_traffic: 0,
      expire: Number(body['expire'] ?? 0),
    };
    users.set(username, record);
    return Response.json({
      data: {
        ...record,
        status: String(body['status'] ?? 'active'),
        subscription_url: `/sub/${username}/LINK`,
      },
    });
  }
  if (request.method === 'PUT' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    if (!user) return Response.json({ detail: 'Not Found' }, { status: 404 });
    user.expire = Number((request.body ?? {})['expire'] ?? user.expire);
    return Response.json({ data: { ...user, subscription_url: `/sub/${username}/LINK` } });
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
 * the notice kinds 'sent' for every OTHER completed purchase so a global
 * sweep only ever counts the service under test. Covers paid kinds plus the
 * isolated test kinds (harmless for cross-class rows: EXISTS/NOT EXISTS
 * mismatch means they never become candidates anyway).
 */
function settleOtherPaidServices(keepOrderId: string): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO service_notifications (order_id, kind, status)
       SELECT o.id, k.kind, 'sent'
         FROM orders o
         CROSS JOIN (SELECT 'expiring' AS kind UNION ALL SELECT 'usage90' UNION ALL SELECT 'free_test_expiring' UNION ALL SELECT 'free_test_usage90' UNION ALL SELECT 'free_test_exhausted') k
        WHERE o.state = 'completed' AND o.kind = 'purchase' AND o.id != ?1`,
    )
    .run(keepOrderId);
}

/** Set live panel usage for a test order (SI bytes on the wire). */
function setTestUsage(orderId: string, usedBytes: number, limitBytes: number): void {
  const row = sqlite.prepare('SELECT pasarguard_username AS u FROM orders WHERE id = ?1').get(orderId) as {
    u: string | null;
  };
  assert.ok(row.u, 'test service is linked on the panel');
  const fake = users.get(row.u as string);
  assert.ok(fake, 'panel user exists for the test service');
  fake.used_traffic = usedBytes;
  fake.data_limit = limitBytes;
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
      { text: fa.menuBuy, style: 'success' },
      { text: fa.menuServices, style: 'success' },
      { text: fa.menuWallet, style: 'success' },
    ],
    'green group intact as row 1',
  );
  assert.equal(menu.is_persistent, undefined);
  // Task 1: the pinned menu shape carries the one-time hide semantics too.
  assert.equal(menu.one_time_keyboard, true);
  const offer = bubbles[1]!;
  assert.ok(String(offer.text).includes('100'), 'ASCII digits for the seeded volume');
  assert.ok(String(offer.text).includes('تست'), 'fa copy names the free test');
  const offerKb = inlineOf(offer.payload);
  assert.equal(offerKb[0][0].callback_data, 'tst:claim');
  assert.ok(offerKb.some((row) => row.some((b) => b.callback_data === 'act:back_menu')));

  // A later /start for the same (unclaimed) newcomer gets exactly one bubble.
  stub.reset();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  assert.equal(sends().length, 1, 'first-ever only');
});

test('P15-04 claim: one order born approved, completed inline, panel POST with ABSOLUTE expire + MB bytes', async () => {
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
  assert.equal(body['data_limit'], 100_000_000, '100 MB stays EXACTLY 100 MB of SI bytes');
  assert.equal('expire_duration' in body, false, 'no ignored relative field on the wire');
  const dayTarget = Math.floor(Date.now() / 1000) + 86_400;
  assert.ok(
    typeof body['expire'] === 'number' &&
      body['expire'] !== 0 &&
      body['expire'] >= dayTarget - 5 &&
      body['expire'] <= dayTarget + 300,
    `absolute one-day expiry, got ${String(body['expire'])}`,
  );
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
    // Phase 23: the entry point stays visible while the admin switch is off —
    // only fulfillment is blocked (exact stopped bubble, wall unburned).
    assert.equal(sends().length, 2, 'disabled → offer bubble STILL shown');
    await dispatch(callbackUpdateAs('tst:claim', nextId(), user));
    assert.equal(
      String(lastSend().text),
      '🛑 رفیق، سرویس تست فعلاً متوقفه 😅\nبه‌محض اینکه دوباره فعالش کنیم، می‌تونی تستت رو بگیری ❤️',
      'disabled tap answers with the exact stopped bubble',
    );
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
  assert.ok(!btns.some((b) => String(b.callback_data ?? '').startsWith('svc:rep')), 'no repurchase affordance on tests');
  assert.ok(btns.some((b) => String(b.callback_data ?? '').startsWith('svc:ref')), 'refresh stays');

  // Forged renew tap: renewal is retired product-wide — retired notice, no flow.
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:rnw:${orderId}`, nextId(), user));
  const answers = stub.sent.filter((s) => s.method === 'answerCallbackQuery');
  assert.ok(answers.length >= 1);
  assert.ok(
    stub.sent.some((s) => String(s.text).includes('حذف شده') || (s.payload['text'] ?? '').toString().includes('حذف شده')),
    'renewRetiredNotice surfaced',
  );
  assert.equal(ordersOf(user.id).length, 1, 'no renewal order was created');

  // A PAID service still shows GB + repurchase — the class split is complete.
  sqlite.prepare(`UPDATE settings SET value = '{"schema":1,"enabled":true,"near_expiry_days":7}' WHERE key = 'repurchase'`).run();
  const paid = freshUser();
  await dispatch(messageUpdateAs(paid, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), paid));
  await dispatch(messageUpdateAs(paid, 'amberForest7', nextId()));
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
    inlineOf(lastSend().payload).flat().some((b) => String(b.callback_data ?? '').startsWith('svc:rep')),
    'repurchase button offered for paid',
  );
  assert.ok(
    !inlineOf(lastSend().payload).flat().some((b) => String(b.callback_data ?? '').startsWith('svc:rnw')),
    'renewal button gone for paid',
  );
});

/* ————— 4. notification policy ————— */

test('P15-11 proof#1: paid legs fire EXACTLY as before for a paid service', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, 'winterRidge7', nextId()));
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
  assert.equal(r.freeTestExhaustedSent, 0, 'fresh 0/100MB test is not exhausted');
  // The isolated test-usage leg polls the panel (fresh 0/100MB → not_yet
  // backoff); the PAID usage90 row must never exist for a claimed order.
  assert.equal(noticeKinds(orderId).filter((k) => k.kind === 'usage90').length, 0);
  assert.equal(noticeKinds(orderId).filter((k) => k.kind === 'expiring').length, 0);
  assert.equal(getsByTestUsername(orderId).length, 2, 'both isolated test legs poll once, then back off');
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_usage90')?.status,
    'pending',
  );

  expires = now + 2 * HOUR_MS - 60_000; // firmly inside the window (slack included)
  setExpiry(orderId, expires);
  stub.panel.reset();
  r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 1, 'exactly one dedicated notice');
  assert.equal(r.expirySent + r.usageSent, 0);
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_expiring')?.status,
    'sent',
    'settled terminal row for the test expiry kind',
  );
  assert.equal(noticeKinds(orderId).filter((k) => k.kind === 'usage90').length, 0);
  assert.equal(noticeKinds(orderId).filter((k) => k.kind === 'expiring').length, 0);
  const copy = textsTo(user.id).find((m) => m.includes('⏳'))!;
  assert.ok(copy.includes('درود زیبا'), 'standalone notice persona rule');
  assert.ok(copy.includes('تست'), 'copy names the test');
  assert.ok(!/گیگ/.test(copy), 'unit-honest: no GB phrasing on a test notice');

  // proof#4: replay at the same instant, in-window, past expiry → nothing, ever.
  r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 0);
  r = await runServiceNotificationSweep(env, now + HOUR_MS);
  assert.equal(r.freeTestSent, 0);
  r = await runServiceNotificationSweep(env, expires + MIN);
  assert.equal(r.freeTestSent, 0, 'already-sent row stays terminal inside the grace');
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_expiring')?.status,
    'sent',
  );
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

/* ————— 5. Phase 15b: isolated test usage + exhausted + expiry grace ————— */

test('P15-15 free_test_usage90 fires once at 90MB with MB copy; 89MB stays silent + backs off', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  const now = Date.now();
  setExpiry(orderId, now + 20 * HOUR_MS); // far from the 2h expiry window
  setTestUsage(orderId, 90_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderId);
  const r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestUsageSent, 1, 'exactly one 90% notice');
  assert.equal(r.usageSent, 0, 'paid usage90 untouched');
  assert.equal(r.expirySent, 0);
  assert.equal(r.freeTestSent, 0);
  const sends = textsTo(user.id).filter((m) => m.includes('📊'));
  assert.equal(sends.length, 1);
  const text = sends[0]!;
  assert.ok(text.startsWith('درود زیبا،'), 'standalone persona');
  assert.ok(text.includes('90٪'), 'percent shown');
  assert.ok(text.includes('10 مگابایت'), 'MB-true remaining');
  assert.ok(!/گیگ/.test(text), 'no GB phrasing on a test notice');
  assert.equal(text.includes('سلام'), false);
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_usage90')?.status,
    'sent',
  );
  assert.equal(noticeKinds(orderId).filter((k) => k.kind === 'usage90').length, 0);

  // Replay + backoff: settled row leaves the candidate set forever.
  stub.reset(); stub.panel.reset();
  const again = await runServiceNotificationSweep(env, now + 2 * HOUR_MS);
  assert.equal(again.freeTestUsageSent, 0);
  assert.equal(textsTo(user.id).filter((m) => m.includes('📊')).length, 0);

  // Below quota: silent + pending backoff, re-polled only after 60 min.
  const user2 = freshUser();
  const order2 = await startAndClaim(user2);
  setExpiry(order2, now + 20 * HOUR_MS);
  setTestUsage(order2, 89_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(order2);
  const r2 = await runServiceNotificationSweep(env, now);
  assert.equal(r2.freeTestUsageSent, 0);
  assert.equal(
    noticeKinds(order2).find((k) => k.kind === 'free_test_usage90')?.status,
    'pending',
  );
  const gets1 = stub.panel.calls.filter((c) => c.method === 'GET').length;
  assert.ok(gets1 >= 1, 'polled once');
  stub.panel.reset();
  await runServiceNotificationSweep(env, now + 10 * MIN);
  assert.equal(stub.panel.calls.filter((c) => c.method === 'GET').length, 0, 'backoff holds');
  const r3 = await runServiceNotificationSweep(env, now + 61 * MIN);
  assert.equal(r3.freeTestUsageSent, 0, 'still below quota after backoff');
  assert.ok(stub.panel.calls.filter((c) => c.method === 'GET').length >= 1, 're-polled');
});

test('P15-16 free_test_exhausted: exact/at-over quota fires once; below/unlimited silent; independent of 90%', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  const now = Date.now();
  setExpiry(orderId, now + 20 * HOUR_MS);
  setTestUsage(orderId, 100_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderId);
  const r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestExhaustedSent, 1, 'exact quota fires');
  // 100% also crosses 90%: both isolated rows may birth on the same sweep.
  assert.equal(r.freeTestUsageSent, 1, '90% leg is independent, not suppressed');
  assert.equal(r.usageSent, 0, 'paid usage90 untouched');
  const texts = textsTo(user.id);
  assert.ok(texts.some((m) => m.includes('تموم شد')), 'fa exhausted copy');
  assert.ok(texts.some((m) => m.includes('🛒 خرید سرویس')), 'soft CTA present');
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_exhausted')?.status,
    'sent',
  );

  // Above quota also counts, but an already-sent row never re-fires.
  setTestUsage(orderId, 120_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  const rOver = await runServiceNotificationSweep(env, now + HOUR_MS);
  assert.equal(rOver.freeTestExhaustedSent, 0, 'once-only even above quota');

  // Overlapping sweeps on a fresh exhausted service: exactly one winner.
  const userO = freshUser();
  const orderO = await startAndClaim(userO);
  setExpiry(orderO, now + 20 * HOUR_MS);
  setTestUsage(orderO, 100_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderO);
  const [a, b] = await Promise.all([
    runServiceNotificationSweep(env, now),
    runServiceNotificationSweep(env, now + 1_000),
  ]);
  assert.equal(a.freeTestExhaustedSent + b.freeTestExhaustedSent, 1);

  // Below quota: silent.
  const userB = freshUser();
  const orderB = await startAndClaim(userB);
  setExpiry(orderB, now + 20 * HOUR_MS);
  setTestUsage(orderB, 50_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderB);
  const rB = await runServiceNotificationSweep(env, now);
  assert.equal(rB.freeTestExhaustedSent, 0);
  assert.equal(textsTo(userB.id).filter((m) => m.includes('تموم شد')).length, 0);

  // Unlimited/unknown quota: never exhausted.
  const userU = freshUser();
  const orderU = await startAndClaim(userU);
  setExpiry(orderU, now + 20 * HOUR_MS);
  setTestUsage(orderU, 999_000_000, 0); // data_limit 0 = panel unlimited
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderU);
  const rU = await runServiceNotificationSweep(env, now);
  assert.equal(rU.freeTestExhaustedSent, 0);
  assert.equal(rU.freeTestUsageSent, 0);

  // English copy.
  const userE = freshUser();
  const orderE = await startAndClaim(userE);
  sqlite.prepare(`UPDATE customers SET language = 'en' WHERE telegram_user_id = ?1`).run(String(userE.id));
  setExpiry(orderE, now + 20 * HOUR_MS);
  setTestUsage(orderE, 100_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderE);
  const rE = await runServiceNotificationSweep(env, now);
  assert.equal(rE.freeTestExhaustedSent, 1);
  const en = textsTo(userE.id).find((m) => /ran out of data/i.test(m))!;
  assert.ok(en, 'english exhausted copy');
  assert.ok(!/[\u0600-\u06FF]/.test(en), 'no Persian leaks into the English notice');
});

test('P15-17 expiry catch-up grace: 10min-past still notifies once; 31min-past stays silent', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const user = freshUser();
  const orderId = await startAndClaim(user);
  const now = Date.now();
  setExpiry(orderId, now - 10 * MIN); // just missed the window, inside grace
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(orderId);
  const r = await runServiceNotificationSweep(env, now);
  assert.equal(r.freeTestSent, 1, 'grace catch-up fires once');
  assert.equal(
    noticeKinds(orderId).find((k) => k.kind === 'free_test_expiring')?.status,
    'sent',
  );
  const again = await runServiceNotificationSweep(env, now + MIN);
  assert.equal(again.freeTestSent, 0, 'terminal after catch-up');

  const user2 = freshUser();
  const order2 = await startAndClaim(user2);
  setExpiry(order2, now - 31 * MIN); // outside the 30-min grace
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(order2);
  const r2 = await runServiceNotificationSweep(env, now);
  assert.equal(r2.freeTestSent, 0, 'outside grace stays silent');
  assert.equal(noticeKinds(order2).filter((k) => k.kind === 'free_test_expiring').length, 0);
});

test('P15-18 migration 0016 rebuild preserves rows and admits the two new kinds', async () => {
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const preFiles = [
    '0001_init.sql', '0002_phase2.sql', '0003_phase3.sql', '0004_phase4.sql', '0005_phase5.sql',
    '0006_phase6.sql', '0007_phase7.sql', '0008_phase8c.sql', '0009_phase9.sql', '0010_phase10.sql',
    '0011_pricing_model.sql', '0012_device_limit.sql', '0013_sales_switch.sql',
    '0014_free_test.sql', '0015_panel_delete.sql',
  ];
  const raw = new DatabaseSync(':memory:');
  for (const f of preFiles) raw.exec(readFileSync(`${here}../migrations/${f}`, 'utf8'));
  raw.exec(`INSERT INTO customers (telegram_user_id) VALUES ('800001');`);
  raw.exec(`INSERT INTO orders (id, customer_id, selections, amount) VALUES ('O9', 1, '{"volume_gb":10}', 45000);`);
  raw.exec(
    `INSERT INTO service_notifications (order_id, kind, status, attempts, last_checked_at)
     VALUES ('O9','expiring','sent',1,NULL), ('O9','usage90','pending',0,NULL), ('O9','free_test_expiring','failed',4,NULL);`,
  );
  const before = raw
    .prepare('SELECT order_id, kind, status, attempts, last_checked_at FROM service_notifications ORDER BY kind')
    .all();
  raw.exec(readFileSync(`${here}../migrations/0016_free_test_notices.sql`, 'utf8'));
  const after = raw
    .prepare('SELECT order_id, kind, status, attempts, last_checked_at FROM service_notifications ORDER BY kind')
    .all();
  assert.deepEqual(after, before);
  raw.exec(`INSERT INTO service_notifications (order_id, kind) VALUES ('O9','free_test_usage90');`);
  raw.exec(`INSERT INTO service_notifications (order_id, kind) VALUES ('O9','free_test_exhausted');`);
  assert.throws(() =>
    raw.exec(`INSERT INTO service_notifications (order_id, kind) VALUES ('O9','bogus_kind');`),
  );
  raw.close();
});

test('P15-19 pure gates: MB math at 90MB, exhausted boundary, expiry grace boundary', async () => {
  const {
    usageNoticeDecision,
    freeTestExhaustedDue,
    freeTestExpiryDue,
  } = await import('../src/handlers/serviceNotifications.ts');
  assert.deepEqual(usageNoticeDecision(90_000_000, 100_000_000), {
    kind: 'due',
    percent: 90,
    remainingGb: 0,
    remainingMb: 10,
  });
  assert.equal(usageNoticeDecision(89_999_999, 100_000_000).kind, 'not_yet');
  assert.equal(usageNoticeDecision(5_000_000, 0).kind, 'not_evaluable');
  assert.equal(usageNoticeDecision(null, 100_000_000).kind, 'not_evaluable');
  assert.equal(freeTestExhaustedDue(100_000_000, 100_000_000).kind, 'due');
  assert.equal(freeTestExhaustedDue(150_000_000, 100_000_000).kind, 'due');
  assert.equal(freeTestExhaustedDue(99_999_999, 100_000_000).kind, 'not_yet');
  assert.equal(freeTestExhaustedDue(9_000_000, 0).kind, 'not_evaluable');
  assert.equal(freeTestExhaustedDue(null, 100_000_000).kind, 'not_evaluable');
  const base = Date.UTC(2026, 0, 1, 12);
  const iso = (ms: number) => new Date(base + ms).toISOString();
  assert.equal(freeTestExpiryDue(iso(2 * HOUR_MS), base), true, 'upper edge still due');
  assert.equal(freeTestExpiryDue(iso(2 * HOUR_MS + 61_000), base), false, 'past upper edge silent');
  assert.equal(freeTestExpiryDue(iso(-10 * MIN), base), true, 'inside 30-min grace');
  assert.equal(freeTestExpiryDue(iso(-31 * MIN), base), false, 'outside grace silent');
  assert.equal(freeTestExpiryDue(null, base), false);
});

test('P15-20 class isolation: paid never gets test kinds, tests never get paid kinds', async () => {
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  // Paid service pushed to 100% + inside paid expiry window.
  const paid = freshUser();
  await dispatch(messageUpdateAs(paid, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), paid));
  await dispatch(messageUpdateAs(paid, 'quartzDune7', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), paid));
  await dispatch(callbackUpdateAs('dur:30', nextId(), paid));
  await dispatch(callbackUpdateAs('dev:1', nextId(), paid));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), paid));
  const draft = ordersOf(paid.id)[0];
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'rc-iso' }, paid));
  await dispatch(callbackUpdateAs(`adm:ok:${draft.id}`, nextId(), ADMIN, ADMIN.id));
  const paidId = ordersOf(paid.id)[0].id;
  const now = Date.now();
  setExpiry(paidId, now + 26 * HOUR_MS);
  const pu = (
    sqlite.prepare('SELECT pasarguard_username AS u FROM orders WHERE id = ?1').get(paidId) as {
      u: string | null;
    }
  ).u as string;
  users.get(pu)!.used_traffic = users.get(pu)!.data_limit;
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(paidId);
  const rp = await runServiceNotificationSweep(env, now);
  assert.equal(rp.expirySent, 1);
  assert.equal(rp.usageSent, 1);
  assert.equal(rp.freeTestUsageSent, 0);
  assert.equal(rp.freeTestExhaustedSent, 0);
  assert.equal(rp.freeTestSent, 0);
  const paidKinds = noticeKinds(paidId).map((k) => k.kind);
  assert.ok(!paidKinds.includes('free_test_usage90'));
  assert.ok(!paidKinds.includes('free_test_exhausted'));
  assert.ok(!paidKinds.includes('free_test_expiring'));

  // Test service at 100%: paid rows must never appear.
  const tuser = freshUser();
  const testId = await startAndClaim(tuser);
  setExpiry(testId, now + 20 * HOUR_MS);
  setTestUsage(testId, 100_000_000, 100_000_000);
  stub.reset(); stub.panel.reset();
  settleOtherPaidServices(testId);
  const rt = await runServiceNotificationSweep(env, now);
  assert.equal(rt.usageSent, 0);
  assert.equal(rt.expirySent, 0);
  assert.equal(rt.freeTestUsageSent, 1);
  assert.equal(rt.freeTestExhaustedSent, 1);
  const testKinds = noticeKinds(testId).map((k) => k.kind);
  assert.ok(!testKinds.includes('usage90'));
  assert.ok(!testKinds.includes('expiring'));
});
