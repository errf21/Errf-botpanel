/**
 * Phase 5 e2e: PasarGuard provisioning after admin approval — fully offline:
 * the panel is a scripted in-memory service behind the fetch stub; the real
 * network is never touched. Covers the approved→provisioning→completed path,
 * the race/claim guards, adopt-existing services, failure → admin `/failed`
 * → `adm:rt` retry → completed, the attempt cap, panel/config fail-closed
 * behavior, and the Phase 1-4 invariant that an unconfigured panel changes
 * NOTHING.
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
import { parseAdminCallback, isValidCallbackData } from '../src/lib/validate.ts';
import { approveOrderByAdmin } from '../src/db/orders.ts';
import { provisionUsername } from '../src/provision/provision.ts';
import type { ProvisionDeps } from '../src/provision/provision.ts';
import {
  extractPanelUser,
  loadPanelConfig,
  resolveSubscriptionUrl,
} from '../src/pasarguard/client.ts';
import { parseProvisioningConfig } from '../src/catalog/provisioning.ts';

const PANEL_KEY = 'PG-SECRET-KEY-42';
const PANEL_BASE = 'https://panel.test';

interface FakeUser {
  id: string;
  username: string;
  status: string;
  subscription_url: string;
}

const users = new Map<string, FakeUser>();
let panelSeq = 100;
const scenario = {
  createFailures: 0,
  lastCreateError: { status: 500, body: { detail: 'panel down' } },
  race409: false,
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
      return Response.json(scenario.lastCreateError.body, { status: scenario.lastCreateError.status });
    }
    const body = request.body ?? {};
    const username = String(body['username'] ?? '');
    if (users.has(username)) return Response.json({ detail: 'already exists' }, { status: 409 });
    if (scenario.race409) {
      scenario.race409 = false;
      users.set(username, {
        id: String(panelSeq++),
        username,
        status: 'active',
        subscription_url: `/sub/${username}/RACETOK`,
      });
      return Response.json({ detail: 'already exists' }, { status: 409 });
    }
    const record: FakeUser = {
      id: String(panelSeq++),
      username,
      status: String(body['status'] ?? 'active'),
      subscription_url: `/sub/${username}/SUBLINK`,
    };
    users.set(username, record);
    return Response.json({ data: { ...record } });
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

function orderById(id: string) {
  return sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as
    | {
        id: string;
        state: string;
        pasarguard_username: string | null;
        pasarguard_user_id: string | null;
        subscription_url: string | null;
        service_created_at: string | null;
        provision_attempts: number;
        failure_reason: string | null;
      }
    | undefined;
}

function eventsOf(id: string): string[] {
  return (
    sqlite
      .prepare('SELECT action FROM order_events WHERE order_id = ?1 ORDER BY id')
      .all(id) as { action: string }[]
  ).map((row) => row.action);
}

async function purchaseToApproval(): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, `cfg-${nextId()}`, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:3', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'PG_RECEIPT' }));
  return String(
    (
      sqlite
        .prepare(
          `SELECT o.id FROM orders o
             JOIN conversation_states s ON s.customer_id = o.customer_id
             JOIN customers c ON c.id = o.customer_id
            WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
            ORDER BY o.created_at DESC LIMIT 1`,
        )
        .get(String(USER.id)) as { id: string }
    ).id,
  );
}

const postCreateCalls = () =>
  stub.panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/user');
const sentTo = (chatId: number) =>
  stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  stub.sent
    .filter((s) => s.method === 'sendMessage')
    .map((s) => String(s.text));

/** Quiet deps for calling provisionOrder() directly (no Telegram side). */
const quietDeps = {
  env,
  db,
  api: { sendMessage: async () => true },
} as unknown as ProvisionDeps;

test('approval provisions exactly once: payload, DB, audit, delivered link', async () => {
  const orderId = await purchaseToApproval();
  stub.reset();
  stub.panel.reset();

  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  const order = orderById(orderId);
  assert.equal(order?.state, 'completed');
  assert.equal(order?.pasarguard_username, `pg${orderId.toLowerCase()}`);
  assert.ok(order?.pasarguard_user_id);
  assert.equal(order?.subscription_url, `https://panel.test/sub/pg${orderId.toLowerCase()}/SUBLINK`);
  assert.ok(order?.service_created_at);
  assert.equal(order?.provision_attempts, 1);
  assert.equal(order?.failure_reason, null);

  assert.deepEqual(
    eventsOf(orderId).slice(-3),
    ['payment_approved', 'provision_started', 'provision_succeeded'],
  );

  // GET-then-POST, never a blind create.
  const calls = stub.panel.calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => [c.method, c.path]),
    [
      ['GET', `/api/user/by-username/pg${orderId.toLowerCase()}`],
      ['POST', '/api/user'],
    ],
  );
  for (const call of calls) assert.equal(call.headers['x-api-key'], PANEL_KEY);
  const payload = calls[1]?.body as Record<string, unknown>;
  assert.equal(payload['username'], `pg${orderId.toLowerCase()}`);
  assert.equal(payload['status'], 'active');
  assert.equal(payload['data_limit'], 10 * 1_000_000_000); // SI bytes (live-verify)
  assert.equal(payload['expire_duration'], 30 * 86_400); // seconds
  assert.equal(payload['hwid_limit'], 3);
  assert.deepEqual(payload['group_ids'], [24, 25]);
  assert.equal(payload['note'], `telbot:${orderId}`);

  const delivered = textsTo(USER.id).find((t) => t.includes('سرویس شما ساخته و فعال شد'));
  assert.ok(delivered, 'completion notice expected');
  assert.ok(delivered?.includes('https://panel.test/sub/'));
  assert.ok(delivered?.includes(orderId));
  // the API key must appear in ZERO telegram-facing text
  assert.equal(stub.sent.some((s) => JSON.stringify(s.payload).includes(PANEL_KEY)), false);
});

test('double approval tap never re-provisions or re-hits the panel', async () => {
  const orderId = String(
    (sqlite.prepare(`SELECT id FROM orders WHERE state = 'completed' ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id,
  );
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(stub.panel.calls.length, 0);
  assert.equal(orderById(orderId)?.state, 'completed');
  assert.equal(sentTo(USER.id).length, 0);
});

test('unconfigured panel is a strict no-op (Phase 1-4 invariants intact)', async () => {
  const orderId = await purchaseToApproval();
  const savedKey = envRef['PASARGUARD_API_KEY'];
  envRef['PASARGUARD_API_KEY'] = '';
  try {
    stub.reset();
    stub.panel.reset();
    await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
    await flush();
    assert.equal(orderById(orderId)?.state, 'approved');
    assert.equal(orderById(orderId)?.provision_attempts, 0);
    assert.equal(stub.panel.calls.length, 0);
    const started = eventsOf(orderId).includes('provision_started');
    assert.equal(started, false);
  } finally {
    envRef['PASARGUARD_API_KEY'] = savedKey;
  }
});

test('broken or disabled provisioning document blocks attempts without writes', async () => {
  const orderId = await purchaseToApproval();
  await approveOrderByAdmin(db, orderId, String(ADMIN.id)); // manual approve, no auto-provision
  const docRow = sqlite.prepare(`SELECT value FROM settings WHERE key = 'provisioning'`).get() as {
    value: string;
  };
  try {
    sqlite
      .prepare(`UPDATE settings SET value = '{"schema": 99}' WHERE key = 'provisioning'`)
      .run();
    stub.panel.reset();
    const broken = await provisionOrder(quietDeps, { orderId });
    assert.deepEqual(broken, { ok: false, skip: 'config_invalid' });

    sqlite
      .prepare(`UPDATE settings SET value = '{"enabled": true}' WHERE key = 'provisioning'`)
      .run();
    assert.deepEqual(await provisionOrder(quietDeps, { orderId }), { ok: false, skip: 'config_invalid' });

    sqlite
      .prepare(
        `UPDATE settings SET value = '{"schema":1,"enabled":false,"group_ids":[24],"username_prefix":"pg","max_attempts":3,"default_status":"active"}' WHERE key = 'provisioning'`,
      )
      .run();
    assert.deepEqual(await provisionOrder(quietDeps, { orderId }), { ok: false, skip: 'disabled' });

    assert.equal(stub.panel.calls.length, 0);
    assert.equal(orderById(orderId)?.state, 'approved');
    assert.equal(orderById(orderId)?.provision_attempts, 0);
  } finally {
    sqlite
      .prepare(`UPDATE settings SET value = ?1 WHERE key = 'provisioning'`)
      .run(docRow.value);
    sqlite.prepare(`UPDATE orders SET state = 'cancelled' WHERE id = ?1`).run(orderId); // cleanup
  }
});

test('panel 500 → failed + admin push; adm:rt retry → completed', async () => {
  const orderId = await purchaseToApproval();
  scenario.createFailures = 1;

  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  let order = orderById(orderId);
  assert.equal(order?.state, 'failed');
  assert.equal(order?.provision_attempts, 1);
  assert.match(String(order?.failure_reason), /^server:500:panel down$/);
  assert.ok(eventsOf(orderId).includes('provision_failed'));
  assert.equal(postCreateCalls().length, 1); // never auto-retried inside one attempt

  assert.ok(textsTo(USER.id).some((t) => t.includes('ساخت سرویس')));
  const push = sentTo(ADMIN.id).find((s) => String(s.text).includes('ساخت سرویس ناموفق بود'));
  assert.ok(push, 'admin push expected');
  assert.ok(String(push.text).includes(orderId));
  assert.equal(JSON.stringify(push.payload).includes(PANEL_KEY), false); // no key in pushes
  const kb = push.payload['reply_markup'] as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.equal(kb.inline_keyboard[0]?.[0]?.callback_data, `adm:rt:${orderId}`);

  // admin retries straight from the push
  stub.reset();
  stub.panel.reset();
  await dispatch(callbackUpdateAs(`adm:rt:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  order = orderById(orderId);
  assert.equal(order?.state, 'completed');
  assert.equal(order?.provision_attempts, 2);
  assert.equal(order?.failure_reason, null);
  assert.equal(postCreateCalls().length, 1);
  assert.ok(
    stub.sent.some(
      (s) => s.method === 'answerCallbackQuery' && String(s.payload['text']).includes('ساخته شد'),
    ),
  );
  assert.equal(stub.sent.some((s) => s.method === 'editMessageCaption'), true); // stale button retired
});

test('admin retry honors the attempt cap; then dead buttons retire', async () => {
  const orderId = await purchaseToApproval();
  scenario.createFailures = 99; // all creates fail for now
  stub.panel.reset();
  try {
    await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
    await flush();
    assert.equal(orderById(orderId)?.state, 'failed');

    for (let i = 2; i <= 3; i++) {
      stub.reset();
      await dispatch(callbackUpdateAs(`adm:rt:${orderId}`, nextId(), ADMIN, ADMIN.id));
      await flush();
      assert.equal(orderById(orderId)?.provision_attempts, i);
    }
    assert.equal(postCreateCalls().length, 3);

    stub.reset();
    stub.panel.reset();
    await dispatch(callbackUpdateAs(`adm:rt:${orderId}`, nextId(), ADMIN, ADMIN.id));
    await flush();
    assert.equal(stub.panel.calls.length, 0); // cap enforced BEFORE any panel contact
    assert.equal(orderById(orderId)?.provision_attempts, 3);
    assert.ok(
      stub.sent.some(
        (s) =>
          s.method === 'answerCallbackQuery' &&
          String(s.payload['text']).includes('سقف تلاش'),
      ),
    );
    assert.equal(stub.sent.some((s) => s.method === 'editMessageCaption'), true);
  } finally {
    scenario.createFailures = 0;
    sqlite.prepare(`UPDATE orders SET state = 'cancelled' WHERE id = ?1`).run(orderId); // cleanup
  }
});

test('existing panel user is adopted without any create call', async () => {
  const orderId = await purchaseToApproval();
  scenario.createFailures = 0;
  scenario.race409 = false;
  const username = provisionUsername(orderId, 'pg');
  users.set(username, {
    id: '777',
    username,
    status: 'active',
    subscription_url: `/sub/${username}/PREEXIST`,
  });

  stub.panel.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();

  assert.equal(postCreateCalls().length, 0);
  const order = orderById(orderId);
  assert.equal(order?.state, 'completed');
  assert.equal(order?.pasarguard_user_id, '777');
  assert.ok(String(order?.subscription_url).includes('PREEXIST'));
});

test('409 create race is resolved by re-reading the winner', async () => {
  const orderId = await purchaseToApproval();
  scenario.createFailures = 0;
  scenario.race409 = true;
  stub.panel.reset();
  try {
    await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
    await flush();

    const order = orderById(orderId);
    assert.equal(order?.state, 'completed');
    assert.ok(String(order?.subscription_url).includes('RACETOK'));
    assert.deepEqual(
      stub.panel.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
  } finally {
    scenario.race409 = false;
  }
});

test('concurrent provisioning: exactly one claim wins, one panel create', async () => {
  const orderId = await purchaseToApproval();
  scenario.createFailures = 0;
  scenario.race409 = false;
  await approveOrderByAdmin(db, orderId, String(ADMIN.id));
  stub.panel.reset();
  const [first, second] = await Promise.all([
    provisionOrder(quietDeps, { orderId }),
    provisionOrder(quietDeps, { orderId }),
  ]);
  const outcomes = [first, second].filter((r) => r.ok === true);
  assert.equal(outcomes.length, 1);
  const loser = [first, second].find((r) => r.ok === false);
  assert.ok(loser !== undefined && 'error' in loser && loser.error === 'state_changed');
  assert.equal(postCreateCalls().length, 1);
  assert.equal(
    (
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?1 AND action = 'provision_started'`)
        .get(orderId) as { n: number }
    ).n,
    1,
  );
  assert.equal(orderById(orderId)?.state, 'completed');
});

test('/failed lists failures with retry buttons for admins only', async () => {
  // produce one failed order
  const orderId = await purchaseToApproval();
  scenario.createFailures = 1;
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(orderById(orderId)?.state, 'failed');
  scenario.createFailures = 0;

  stub.reset();
  await dispatch(messageUpdateAs(USER, '/failed', nextId()));
  assert.ok(textsTo(USER.id).some((t) => t.includes('دسترس')));
  assert.equal(textsTo(USER.id).some((t) => t.includes(orderId)), false);

  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/failed', nextId()));
  const queue = sentTo(ADMIN.id).find((s) => String(s.text).includes('سفارش‌های ناموفق'));
  assert.ok(queue);
  assert.ok(String(queue.text).includes(orderId));
  assert.ok(String(queue.text).includes('panel down'));
  const kb = queue.payload['reply_markup'] as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.equal(kb.inline_keyboard.flat().some((b) => b.callback_data === `adm:rt:${orderId}`), true);

  // recover through the queue button
  stub.reset();
  await dispatch(callbackUpdateAs(`adm:rt:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(orderById(orderId)?.state, 'completed');
});

test('rt callbacks: vocabulary accepts strict form only', () => {
  const good = 'adm:rt:' + newOrderId();
  assert.equal(isValidCallbackData(good), true);
  assert.deepEqual(parseAdminCallback(good)?.action, 'rt');
  assert.equal(parseAdminCallback('adm:rt:' + 'I'.repeat(28)), null);
  assert.equal(parseAdminCallback(`adm:xx:${newOrderId()}`), null);
});

test('client helpers fail closed on config and parse odd shapes', () => {
  assert.equal(
    loadPanelConfig({ PASARGUARD_API_KEY: '', PASARGUARD_PANEL_URL: PANEL_BASE }).ok,
    false,
  );
  assert.deepEqual(
    loadPanelConfig({ PASARGUARD_API_KEY: 'k', PASARGUARD_PANEL_URL: 'http://panel.test' }),
    { ok: false, kind: 'bad_url', detail: 'panel_url_rejected' },
  );
  assert.deepEqual(
    loadPanelConfig({ PASARGUARD_API_KEY: 'k', PASARGUARD_PANEL_URL: PANEL_BASE + '/prefix' }),
    { ok: false, kind: 'bad_url', detail: 'panel_url_rejected' },
  );
  assert.equal(resolveSubscriptionUrl(PANEL_BASE, '/sub/a/b'), 'https://panel.test/sub/a/b');
  assert.equal(
    resolveSubscriptionUrl(PANEL_BASE, 'https://other.example/x'),
    'https://other.example/x',
  );
  assert.equal(resolveSubscriptionUrl(PANEL_BASE, 'javascript:alert(1)'), null);
  assert.equal(extractPanelUser({ data: { username: 'x', id: 5 } })?.id, '5');
  assert.equal(extractPanelUser('garbage'), null);
});

test('provisioning policy parser rejects hostile/undersized documents', () => {
  const base = {
    schema: 1,
    enabled: true,
    group_ids: [24, 25],
    username_prefix: 'pg',
    max_attempts: 3,
    default_status: 'active',
  };
  assert.equal(parseProvisioningConfig(base).ok, true);
  assert.equal(parseProvisioningConfig({ ...base, group_ids: [] }).ok, false);
  assert.equal(parseProvisioningConfig({ ...base, group_ids: [2.5] }).ok, false);
  assert.equal(parseProvisioningConfig({ ...base, username_prefix: 'پیشوند' }).ok, false);
  assert.equal(parseProvisioningConfig({ ...base, username_prefix: 'abcd' }).ok, true);
  assert.equal(parseProvisioningConfig({ ...base, max_attempts: 99 }).ok, false);
  assert.equal(parseProvisioningConfig({ ...base, default_status: 'deleted' }).ok, false);
});
