/**
 * Phase 24 — admin-configurable free-test volume (SI megabytes, exact).
 *
 * Canonical rule under test: volume_mb (int) → data_limit = volume_mb ×
 * 1,000,000 bytes; 1 GB = 1000 MB (SI — never the paid binary GiB).
 *  - parser units: exact MB/GB/integer/range behavior, Fa digits, no clamping
 *  - 50 MB / 500 MB / 1 GB end-to-end: D1 value → admin screen → user offer →
 *    exact PasarGuard data_limit (50_000_000 / 500_000_000 / 1_000_000_000)
 *  - pre-existing test service byte-identical after a volume change
 *  - volume change never flips `enabled`; invalid input never mutates
 *  - D1 reload persistence; zero panel calls from the setting flow itself
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdateAs,
  type PanelRequest,
} from './helpers.ts';

interface FakePanelUser {
  id: string;
  username: string;
  data_limit: number;
  used_traffic: number;
  expire: number;
}

const PANEL_BASE = 'https://panel.test';
const users = new Map<string, FakePanelUser>();
let panelSeq = 9000;
function panelRespond(request: PanelRequest): Response {
  if (request.method === 'GET' && request.path.startsWith('/api/user/by-username/')) {
    const username = decodeURIComponent(request.path.slice('/api/user/by-username/'.length));
    const user = users.get(username);
    return user
      ? Response.json({ data: { ...user, status: 'active', subscription_url: `/sub/${username}/LINK` } })
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
      expire: Number(body['expire'] ?? 0),
    };
    users.set(username, record);
    return Response.json({
      data: { ...record, status: String(body['status'] ?? 'active'), subscription_url: `/sub/${username}/LINK` },
    });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}
const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
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

let counter = 180000;
const nextId = () => ++counter;
const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');
const { newOrderId } = await import('../src/lib/security.ts');
const { parseTestVolume } = await import('../src/db/freeTestSwitch.ts');

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
const lastTextTo = (chatId: number): string => textsTo(chatId).at(-1) ?? '';
const postsToPanel = () => stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');

const freeDoc = () =>
  sqlite.prepare(`SELECT value FROM settings WHERE key = 'free_test'`).get() as { value: string };
const docOf = () => JSON.parse(freeDoc().value) as Record<string, unknown>;
const setFreeTestDoc = (volumeMb: number, enabled = true) =>
  sqlite
    .prepare(`UPDATE settings SET value = ?1 WHERE key = 'free_test'`)
    .run(JSON.stringify({ schema: 1, enabled, volume_mb: volumeMb, duration_days: 1, device_count: 1 }));

const volUser = (n: number) => ({ id: 820000 + n, first_name: `Vol${n}`, username: `vol_user_${n}`, language_code: 'fa' });

async function claimAs(user: { id: number }): Promise<string> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('tst:claim', nextId(), user, user.id));
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(user.id)) as { id: number }).id;
  const claim = sqlite.prepare('SELECT order_id FROM free_test_claims WHERE customer_id = ?1').get(cid) as {
    order_id: string;
  };
  return claim.order_id;
}

test('parser: exact SI/integer/range behavior, never clamps', async () => {
  assert.deepEqual(parseTestVolume('50MB'), { ok: true, volumeMb: 50 });
  assert.deepEqual(parseTestVolume('50 MB'), { ok: true, volumeMb: 50 });
  assert.deepEqual(parseTestVolume('500mb'), { ok: true, volumeMb: 500 });
  assert.deepEqual(parseTestVolume('1GB'), { ok: true, volumeMb: 1000 });
  assert.deepEqual(parseTestVolume('2 gb'), { ok: true, volumeMb: 2000 });
  assert.deepEqual(parseTestVolume('۵۰۰MB'), { ok: true, volumeMb: 500 });
  assert.deepEqual(parseTestVolume('100000MB'), { ok: true, volumeMb: 100000 });
  assert.deepEqual(parseTestVolume('100GB'), { ok: true, volumeMb: 100000 });
  for (const bad of ['', '   ', '0MB', '-5MB', 'abc', '500XB', '50', 'MB', '1.5GB', '2.5MB', '100001MB', '101GB', '50 MB extra', '0x10MB']) {
    const r = parseTestVolume(bad);
    assert.equal(r.ok, false, `${bad} must reject`);
  }
});

test('A: 50 MB end-to-end exact (D1 → admin → offer → 50_000_000 bytes)', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 50MB', nextId()));
  const doc = docOf();
  assert.equal(doc['volume_mb'], 50, 'D1 stores exactly 50');
  assert.equal(doc['enabled'], true, 'enabled preserved');
  assert.equal(doc['duration_days'], 1, 'duration preserved');
  assert.equal(doc['device_count'], 1, 'devices preserved');
  assert.equal(stub.panel.calls.length, 0, 'setting flow makes zero panel calls');
  assert.ok(lastTextTo(ADMIN.id).includes('✅'), 'applied confirmation');

  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes('📦 حجم تست: 50 MB'), 'admin screen shows 50 MB');

  const u = volUser(1);
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  assert.ok(lastTextTo(u.id).includes('50'), 'offer shows 50');
  assert.ok(!lastTextTo(u.id).includes('100 م'), 'no stale 100 in offer');

  await dispatch(callbackUpdateAs('tst:claim', nextId(), u, u.id));
  const posts = postsToPanel();
  assert.ok(posts.length >= 1, 'provisioning attempted');
  assert.equal(posts.at(-1)?.body?.['data_limit'], 50_000_000, 'panel quota EXACTLY 50 MB in bytes');
});

test('B: 500 MB everywhere, no stale 100 MB in free-test UI', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 500MB', nextId()));
  assert.equal(docOf()['volume_mb'], 500);
  await dispatch(messageUpdateAs(ADMIN, '/stoptest', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes('📦 حجم تست: 500 MB'));

  const u = volUser(2);
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  const offer = lastTextTo(u.id);
  assert.ok(offer.includes('500'), 'offer shows 500');
  assert.ok(!offer.includes('100'), 'no stale 100 anywhere in the offer bubble');

  await dispatch(callbackUpdateAs('tst:claim', nextId(), u, u.id));
  assert.equal(postsToPanel().at(-1)?.body?.['data_limit'], 500_000_000, 'panel quota EXACTLY 500 MB in bytes');
});

test('C: 1 GB means SI 1000 MB = 1_000_000_000 bytes, no rounding', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 1GB', nextId()));
  assert.equal(docOf()['volume_mb'], 1000, 'GB stored as SI megabytes');
  const u = volUser(3);
  await dispatch(callbackUpdateAs('tst:claim', nextId(), u, u.id));
  // Direct claim (no /start offer needed): the tap path reads live config.
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(u.id)) as { id: number } | undefined)?.id;
  assert.ok(cid !== undefined, 'claim registers the customer');
  assert.equal(postsToPanel().at(-1)?.body?.['data_limit'], 1_000_000_000, 'panel quota EXACTLY 1 GB SI in bytes');
});

test('D: pre-existing service byte-identical after volume changes', async () => {
  const vet = { id: 820099, first_name: 'Vet', username: 'vol_veteran', language_code: 'fa' };
  await dispatch(messageUpdateAs(vet, '/start', nextId()));
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(vet.id)) as { id: number }).id;
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
      cid,
      JSON.stringify({ schema: 1, free_test: true, config_name: 'OLDTEST', volume_mb: 100, duration_days: 1, device_count: 1 }),
      `panel_${orderId.toLowerCase()}`,
      `https://panel.test/sub/SECRET_${orderId}`,
      stamp,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
  sqlite.prepare('INSERT INTO free_test_claims (customer_id, order_id) VALUES (?1, ?2)').run(cid, orderId);
  const before = JSON.stringify(sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(orderId));

  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 50MB', nextId()));
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 2GB', nextId()));
  assert.equal(
    JSON.stringify(sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(orderId)),
    before,
    'old service row byte-identical across volume changes',
  );
  assert.equal(docOf()['volume_mb'], 2000, 'latest change applied');
});

test('F+G: stopped keeps button + exact bubble; volume change never enables; re-enable honors current volume', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 500MB', nextId()));
  await dispatch(callbackUpdateAs('stp:stop', nextId(), ADMIN, ADMIN.id));
  assert.equal(docOf()['enabled'], false);

  const u = volUser(4);
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  assert.equal(textsTo(u.id).length, 2, 'offer bubble still shown while stopped');
  assert.ok(lastTextTo(u.id).includes('500'), 'stopped offer still shows current volume');
  await dispatch(callbackUpdateAs('tst:claim', nextId(), u, u.id));
  assert.equal(lastTextTo(u.id), fa.freeTestStoppedNotice, 'exact bubble unchanged');

  // Volume change while stopped must NOT enable.
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 50MB', nextId()));
  assert.equal(docOf()['enabled'], false, 'stays disabled');
  assert.equal(docOf()['volume_mb'], 50);

  await dispatch(callbackUpdateAs('stp:start', nextId(), ADMIN, ADMIN.id));
  const u2 = volUser(5);
  await claimAs(u2);
  assert.equal(postsToPanel().at(-1)?.body?.['data_limit'], 50_000_000, 'post-enable claim uses current volume');
});

test('H: invalid inputs mutate nothing', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 50MB', nextId()));
  const good = freeDoc().value;
  for (const bad of ['/stoptest vol ', '/stoptest vol 0MB', '/stoptest vol -5MB', '/stoptest vol abc', '/stoptest vol 500XB', '/stoptest vol 100001MB', '/stoptest vol 101GB', '/stoptest vol 1.5GB', '/stoptest vol 50']) {
    await dispatch(messageUpdateAs(ADMIN, bad, nextId()));
    assert.equal(freeDoc().value, good, `${bad} leaves config untouched`);
    assert.ok(lastTextTo(ADMIN.id).includes('/stoptest vol 500MB'), 'format help shown');
  }
});

test('I+O: D1 reload persistence; setting flow is panel-free; hygiene restore', async () => {
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/stoptest vol 500MB', nextId()));
  assert.equal(stub.panel.calls.length, 0, 'merely changing the setting never calls the panel');
  const reloaded = JSON.parse(
    (sqlite.prepare(`SELECT value FROM settings WHERE key = 'free_test'`).get() as { value: string }).value,
  ) as Record<string, unknown>;
  assert.equal(reloaded['volume_mb'], 500, 'survives a fresh D1 read');
  assert.equal(reloaded['enabled'], true);
  // Restore the seeded default for repo hygiene.
  setFreeTestDoc(100, true);
  assert.equal(docOf()['volume_mb'], 100);
});
