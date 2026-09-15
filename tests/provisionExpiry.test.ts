/**
 * Provisioning expiry + volume regressions (production incidents, 2026-09).
 *
 * Issue #1 — duration silently became Unlimited: `POST /api/user` ignored the
 * relative `expire_duration`; the fix sends the panel's REAL field — the
 * absolute `expire` (unix seconds) proven by the renewal PUT primitive — and
 * verifies/repairs it before an order may complete. Pinned per month tier
 * (1/2/3 → 30/60/90 days), with an explicit `expire !== 0` no-Unlimited
 * guard, and proof the renewal ladder keeps stacking absolute expiry exactly.
 *
 * Issue #2 — selected GB displayed smaller: the panel counts `data_limit` in
 * GiB, so N selected GB must ship N × 2^30 bytes (10 → 10.00 GiB on the
 * panel). The free test stays EXACTLY 100 MB = 100_000_000 SI bytes.
 *
 * Orders are seeded straight to `approved` (the state machine, pricing and
 * checkout paths are covered elsewhere); provisioning runs inline.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  type PanelRequest,
} from './helpers.ts';
import { newOrderId } from '../src/lib/security.ts';
import { provisionOrder, provisionUsername } from '../src/provision/provision.ts';
import type { ProvisionDeps } from '../src/provision/provision.ts';

const PANEL_KEY = 'PG-SECRET-KEY-42';
const PANEL_BASE = 'https://panel.test';
const GIB = 1_073_741_824;
const DAY_SECONDS = 86_400;

interface FakeUser {
  id: string;
  username: string;
  status: string;
  subscription_url: string;
  expire: number; // absolute unix seconds; 0 = panel "Unlimited"
  data_limit: number;
  used_traffic: number;
}

const users = new Map<string, FakeUser>();
let panelSeq = 300;

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
      expire: Number(body['expire'] ?? 0), // absolute, as the panel really stores it
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
    user.expire = Number((request.body ?? {})['expire'] ?? user.expire);
    return Response.json({ data: { ...user } });
  }
  return Response.json({ detail: 'no route' }, { status: 404 });
}

const stub = makeFetchStub({ base: PANEL_BASE, respond: panelRespond });
after(() => stub.restore());

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const db = shim as unknown as D1Database;
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PASARGUARD_API_KEY: PANEL_KEY,
  PASARGUARD_PANEL_URL: PANEL_BASE,
} as unknown as ProvisionDeps['env'];

const quietDeps: ProvisionDeps = {
  env,
  db,
  api: { sendMessage: async () => true } as unknown as ProvisionDeps['api'],
};

let tgSeq = 777_000_000;

/** Seed ONE approved purchase with an exact snapshot; returns its order id. */
function seedApprovedPurchase(selections: Record<string, unknown>): string {
  const id = newOrderId();
  const tgId = String(++tgSeq);
  sqlite
    .prepare('INSERT INTO customers (telegram_user_id) VALUES (?1)')
    .run(tgId);
  const cid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(tgId) as {
    id: number;
  }).id;
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, selections, amount, currency)
       VALUES (?1, ?2, 'approved', ?3, 45000, 'IRT')`,
    )
    .run(id, cid, JSON.stringify(selections));
  return id;
}

function seedApprovedRenewal(serviceId: string, customerId: number, durationDays: number): string {
  const id = newOrderId();
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, selections, amount, currency, kind, renews_order_id)
       VALUES (?1, ?2, 'approved', ?3, 80000, 'IRT', 'renewal', ?4)`,
    )
    .run(
      id,
      customerId,
      JSON.stringify({ schema: 1, kind: 'renewal', duration_days: durationDays, renews_order_id: serviceId }),
      serviceId,
    );
  return id;
}

const posts = () => stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');
const puts = () =>
  stub.panel.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/api/user/by-username/'));
const orderRow = (id: string) =>
  sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as Record<string, unknown>;

/**
 * Shared create-shape check: exact GiB bytes, absolute non-zero expire at
 * now + durationDays, the legacy relative field gone, completion booked from
 * the PANEL's verified expiry, and zero corrective PUTs on a healthy panel.
 */
async function expectCreateShape(
  orderId: string,
  gb: number,
  durationDays: number,
  note: string,
): Promise<FakeUser> {
  stub.reset();
  stub.panel.reset();
  const outcome = await provisionOrder(quietDeps, { orderId });
  assert.equal(outcome.ok, true, `${note}: provisions clean`);

  const created = posts().filter((p) => p.body?.['note'] === `telbot:${orderId}`);
  assert.equal(created.length, 1, `${note}: exactly one create`);
  const body = created[0]!.body as Record<string, unknown>;
  assert.equal(body['data_limit'], gb * GIB, `${note}: ${gb} GiB of bytes EXACTLY on the wire`);
  assert.equal('expire_duration' in body, false, `${note}: relative field must never ship`);
  const target = Math.floor(Date.now() / 1000) + durationDays * DAY_SECONDS;
  assert.ok(
    typeof body['expire'] === 'number' &&
      body['expire'] >= target - 5 &&
      body['expire'] <= target + 300,
    `${note}: absolute expire ≈ now + ${durationDays}d, got ${String(body['expire'])}`,
  );
  assert.notEqual(body['expire'], 0, `${note}: a finite expiry is ALWAYS sent (never Unlimited)`);

  assert.equal(puts().length, 0, `${note}: a panel that applied the create expiry needs NO PUT`);
  const username = provisionUsername(orderId, 'pg');
  const panel = users.get(username);
  assert.ok(panel !== undefined, `${note}: panel user exists`);
  assert.ok(
    panel.expire >= target - 5 && panel.expire <= target + 300,
    `${note}: panel shows the finite expiry (not Unlimited)`,
  );
  const row = orderRow(orderId);
  assert.equal(row['state'], 'completed', `${note}: completed`);
  assert.equal(
    row['service_expires_at'],
    new Date(panel.expire * 1000).toISOString(),
    `${note}: stored expiry is the VERIFIED panel value, never local arithmetic`,
  );
  return panel;
}

/* ————————————————————— 1 month / 2 months / 3 months ————————————————————— */

test('1 month (30d): absolute expire in the create POST, booked from the panel', async () => {
  const id = seedApprovedPurchase({ schema: 1, volume_gb: 10, duration_days: 30, device_count: 1 });
  await expectCreateShape(id, 10, 30, '1 month');
});

test('2 months (60d): exact wire shape', async () => {
  const id = seedApprovedPurchase({ schema: 1, volume_gb: 10, duration_days: 60, device_count: 1 });
  await expectCreateShape(id, 10, 60, '2 months');
});

test('3 months (90d): exact wire shape', async () => {
  const id = seedApprovedPurchase({ schema: 1, volume_gb: 10, duration_days: 90, device_count: 1 });
  await expectCreateShape(id, 10, 90, '3 months');
});

/* ————————————————————— GiB-exact volumes (issue #2) ————————————————————— */

test('ladder 20/30/40 GB ship as EXACTLY N × 2^30 bytes', async () => {
  for (const gb of [20, 30, 40]) {
    const id = seedApprovedPurchase({ schema: 1, volume_gb: gb, duration_days: 30, device_count: 1 });
    await expectCreateShape(id, gb, 30, `${String(gb)} GB`);
  }
});

test('custom 15 GB (UI ladder beyond) converts binary too; the old 30 GB → 27.94 GiB bug is gone', async () => {
  const id = seedApprovedPurchase({ schema: 1, volume_gb: 15, duration_days: 30, device_count: 1 });
  const panel = await expectCreateShape(id, 15, 30, 'custom 15');
  assert.equal(panel.data_limit, 15 * 2 ** 30, 'panel-side bytes equal 15 GiB exactly');
});

test('free test stays EXACTLY 100 MB = 100_000_000 SI bytes (never 100 GiB)', async () => {
  const id = seedApprovedPurchase({
    schema: 1,
    free_test: true,
    volume_mb: 100,
    duration_days: 1,
    device_count: 1,
  });
  stub.reset();
  stub.panel.reset();
  const outcome = await provisionOrder(quietDeps, { orderId: id });
  assert.equal(outcome.ok, true);
  const body = posts().find((p) => p.body?.['note'] === `telbot:${id}`)!.body as Record<string, unknown>;
  assert.equal(body['data_limit'], 100_000_000, 'MB path keeps its historical SI bytes');
  assert.notEqual(body['data_limit'], 100 * 1024 * 1024, 'and did NOT get rebased to binary');
  assert.notEqual(body['expire'], 0, 'free test also carries a finite absolute expiry');
  assert.equal(
    users.get(provisionUsername(id, 'pg'))!.data_limit,
    100_000_000,
    'panel stores the same 100 MB cap',
  );
});

/* ————————————————————— renewal stacking regression ————————————————————— */

test('renewal still extends from the VERIFIED create expiry by exactly the bought days', async () => {
  const serviceId = seedApprovedPurchase({ schema: 1, volume_gb: 30, duration_days: 30, device_count: 3 });
  stub.panel.reset();
  assert.equal((await provisionOrder(quietDeps, { orderId: serviceId })).ok, true);
  const username = provisionUsername(serviceId, 'pg');
  const createdExpire = users.get(username)!.expire;

  const cid = Number(orderRow(serviceId)['customer_id']);
  const renewalId = seedApprovedRenewal(serviceId, cid, 60);
  stub.panel.reset();
  const outcome = await provisionOrder(quietDeps, { orderId: renewalId });
  assert.equal(outcome.ok, true, 'renewal provisions');
  const applied = puts();
  assert.equal(applied.length, 1, 'exactly one modify');
  assert.equal(
    applied[0]!.body?.['expire'],
    createdExpire + 60 * DAY_SECONDS,
    'target = verified panel expiry + 60 days (no stacking drift, no reset to now)',
  );
  assert.equal(orderRow(renewalId)['state'], 'completed');
  assert.equal(
    orderRow(serviceId)['service_expires_at'],
    new Date((createdExpire + 60 * DAY_SECONDS) * 1000).toISOString(),
    'the service row books the renewal forward onto the panel-verified value',
  );
});

/* ————————————————— idempotency across the verification steps ————————————————— */

test('one order = one create, ever: completed is terminal and a re-provision adopts', async () => {
  const id = seedApprovedPurchase({ schema: 1, volume_gb: 10, duration_days: 90, device_count: 1 });
  stub.panel.reset();
  assert.equal((await provisionOrder(quietDeps, { orderId: id })).ok, true);
  assert.equal(posts().length, 1);
  const expire1 = users.get(provisionUsername(id, 'pg'))!.expire;

  // A second "retry" against the completed row claims with ZERO calls…
  stub.panel.reset();
  const again = await provisionOrder(quietDeps, { orderId: id, retry: true });
  assert.deepEqual(again, { ok: false, error: 'state_changed' }, 'completed is terminal');
  assert.equal(stub.panel.calls.length, 0, 'and no panel traffic at all');

  // …while an attempt replayed through the claim machinery ADOPTS the same
  // panel user — never a second create, never a re-rolled expiry.
  sqlite
    .prepare(`UPDATE orders SET state = 'approved', provision_attempts = 0 WHERE id = ?1`)
    .run(id);
  stub.panel.reset();
  const adopted = await provisionOrder(quietDeps, { orderId: id });
  assert.equal(adopted.ok, true, 'adopts the existing service');
  assert.equal(posts().length, 0, 'never a second create');
  assert.equal(puts().length, 0, 'a valid expiry needs no repair');
  assert.equal(users.get(provisionUsername(id, 'pg'))!.expire, expire1, 'expiry untouched by adoption');
});
