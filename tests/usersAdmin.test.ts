/**
 * Phase 20 — /users admin dashboard.
 *
 * Covers (fully offline, snapshot/D1 only):
 *  - non-admin: exact cmdAdminOnly denial, forged usr: taps neutral, zero leakage
 *  - S0 dashboard: counts + nav only, never user rows
 *  - pagination: 8/page, prev/next, out-of-range clamp
 *  - search: /users <id|@username> found / not-found / invalid
 *  - profile card: compact, no secrets
 *  - services: active/expired/panel-deleted distinction, cross-user blocked
 *  - orders: full history paginated, renewal vs repurchase labels preserved
 *  - wallet: read-only view + /credit hint, viewing mutates nothing
 *  - repurchases: separated view, cancel via existing adm:cancel only
 *  - callback validation: hostile usr: payloads rejected
 *  - message cap: every dashboard bubble < 4000 chars
 *  - regression: existing admin commands + main menu untouched
 *  - zero PasarGuard traffic while browsing
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
  messageUpdateAs,
} from './helpers.ts';

const PANEL_BASE = 'https://panel.test';
const stub = makeFetchStub({
  base: PANEL_BASE,
  respond: () => Response.json({ detail: 'dashboard must never call the panel' }, { status: 500 }),
});
after(() => stub.restore());

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
} as unknown as Parameters<typeof processTelegramUpdate>[1];

let counter = 90000;
const nextId = () => ++counter;
const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');
const { parseUsersCallback, isValidCallbackData } = await import('../src/lib/validate.ts');
const { newOrderId } = await import('../src/lib/security.ts');

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
const lastTextTo = (chatId: number): string => textsTo(chatId).at(-1) ?? '';
const buttonsOf = (chatId: number): string[] => {
  const data: string[] = [];
  for (const s of sentTo(chatId)) {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) if (b.callback_data !== undefined) data.push(b.callback_data);
    }
  }
  return data;
};
const buttonLabelsOf = (chatId: number): string[] => {
  const labels: string[] = [];
  for (const s of sentTo(chatId)) {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { text?: string }[][] } | undefined;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const b of row) if (b.text !== undefined) labels.push(b.text);
    }
  }
  return labels;
};

function customerIdOf(tgId: number): number {
  const row = sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(tgId)) as {
    id: number;
  };
  return row.id;
}

function insertPurchase(opts: {
  customerId: number;
  name: string;
  state?: string;
  daysAgo?: number;
  expiresInDays?: number | null;
  deleted?: boolean;
}): string {
  const id = newOrderId();
  const created = new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000).toISOString();
  const expires =
    opts.expiresInDays === null || opts.expiresInDays === undefined
      ? null
      : new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString();
  sqlite.exec('BEGIN');
  try {
    sqlite
      .prepare(
        `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency,
           pasarguard_username, subscription_url, service_created_at, service_expires_at,
           panel_deleted_at, panel_deleted_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'purchase', ?4, 100000, 'IRT', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
      )
      .run(
        id,
        opts.customerId,
        opts.state ?? 'completed',
        JSON.stringify({ config_name: opts.name, volume_gb: 10, duration_days: 30, device_count: 1 }),
        `panel_${id.toLowerCase()}`,
        `https://panel.test/sub/SECRET_${id}`,
        created,
        expires,
        opts.deleted === true ? created : null,
        opts.deleted === true ? `admin:${ADMIN.id}` : null,
        created,
      );
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  return id;
}

function insertRenewal(opts: { customerId: number; serviceId: string; repurchase: boolean; state?: string }): string {
  const id = newOrderId();
  const selections = opts.repurchase
    ? JSON.stringify({ kind: 'repurchase', repurchases_order_id: opts.serviceId, volume_gb: 10, duration_days: 30, device_count: 1 })
    : JSON.stringify({ renews_order_id: opts.serviceId, duration_days: 30 });
  sqlite
    .prepare(
      `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency, renews_order_id, repurchase_mode, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'renewal', ?4, 50000, 'IRT', ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(id, opts.customerId, opts.state ?? 'completed', selections, opts.serviceId, opts.repurchase ? 'same' : null);
  return id;
}

const BERLIN = { id: 770001, first_name: 'Berlin', username: 'berlin_user', language_code: 'fa' };
const SARA = { id: 770002, first_name: 'Sara', username: 'sara_shop', language_code: 'fa' };

test('non-admin /users gets the exact cmdAdminOnly denial with zero dashboard leakage', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(messageUpdateAs(USER, '/users', nextId()));
  const texts = textsTo(USER.id);
  assert.ok(texts.includes(fa.cmdAdminOnly), 'exact denial message');
  assert.equal(fa.cmdAdminOnly, '❌ این دستور در دسترس شما نیست.');
  assert.ok(!texts.some((t) => t.includes(fa.usersDashboardHeader)), 'no dashboard content leaks');
});

test('non-admin forged usr: callback is neutralized with zero writes', async () => {
  stub.reset();
  const before = (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  await dispatch(callbackUpdateAs('usr:menu', nextId(), USER, USER.id));
  await dispatch(callbackUpdateAs('usr:list:det:0', nextId(), USER, USER.id));
  const afterCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  assert.equal(afterCount, before, 'zero writes');
  assert.equal(textsTo(USER.id).filter((t) => t.includes(fa.usersDashboardHeader)).length, 0);
});

test('admin S0 dashboard shows counts + nav only, never user rows', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  await dispatch(messageUpdateAs(BERLIN, '/start', nextId()));
  await dispatch(messageUpdateAs(SARA, '/start', nextId()));
  await dispatch(messageUpdateAs(ADMIN, '/users', nextId()));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes(fa.usersDashboardHeader));
  assert.ok(text.includes('👥 کاربران:'));
  assert.ok(text.includes('سرویس‌های فعال:'));
  assert.ok(text.includes('کل سرویس‌ها:'));
  assert.ok(text.includes('خریدهای مجدد فعال:'));
  assert.ok(!text.includes('berlin_user'), 'S0 must not list user rows');
  const labels = buttonLabelsOf(ADMIN.id);
  for (const expected of [fa.usersBtnUsers, fa.usersBtnSearch, fa.usersBtnServices, fa.usersBtnOrders, fa.usersBtnRepurchases, fa.usersBtnWallet]) {
    assert.ok(labels.includes(expected), `nav has ${expected}`);
  }
  assert.ok(text.length < 4000);
});

test('user list paginates at 8/page with prev/next + back', async () => {
  stub.reset();
  for (let i = 0; i < 10; i++) {
    const u = { id: 780000 + i, first_name: `Fan${i}`, username: `fan_user_${i}`, language_code: 'fa' };
    await dispatch(messageUpdateAs(u, '/start', nextId()));
  }
  await dispatch(callbackUpdateAs('usr:list:det:0', nextId(), ADMIN, ADMIN.id));
  const page0 = lastTextTo(ADMIN.id);
  assert.ok(page0.includes(fa.usersListHeader));
  const rows0 = page0.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(rows0.length, 8, 'max 8 rows on page 0');
  const buttons0 = buttonsOf(ADMIN.id);
  assert.ok(buttons0.includes('usr:list:det:1'), 'has next');
  assert.ok(!buttons0.includes('usr:list:det:-1'));
  assert.ok(buttons0.includes('usr:menu'), 'has back to dashboard');

  await dispatch(callbackUpdateAs('usr:list:det:1', nextId(), ADMIN, ADMIN.id));
  const page1 = lastTextTo(ADMIN.id);
  const rows1 = page1.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(rows1.length >= 1 && rows1.length <= 8);
  const buttons1 = buttonsOf(ADMIN.id);
  assert.ok(buttons1.includes('usr:list:det:0'), 'has prev');
  assert.ok(lastTextTo(ADMIN.id).length < 4000);
});

test('search: /users <id|@username> found / not-found / invalid', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/users ${BERLIN.id}`, nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes(String(BERLIN.id)), 'numeric search opens profile');

  await dispatch(messageUpdateAs(ADMIN, '/users @berlin_user', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes('@berlin_user'), 'username search opens profile');

  await dispatch(messageUpdateAs(ADMIN, '/users @SARA_SHOP', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes('@sara_shop'), 'username search is case-insensitive');

  await dispatch(messageUpdateAs(ADMIN, '/users 999000111', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.usersNotFound);

  await dispatch(messageUpdateAs(ADMIN, '/users @no_such_user_xyz', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.usersNotFound);

  await dispatch(messageUpdateAs(ADMIN, '/users !!!', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes('/users'), 'invalid shows usage');
});

test('profile card is compact and exposes no secrets', async () => {
  stub.reset();
  const cid = customerIdOf(BERLIN.id);
  const secretService = insertPurchase({ customerId: cid, name: 'ERRF01', expiresInDays: 20 });
  const secretUrl = sqlite.prepare('SELECT subscription_url FROM orders WHERE id = ?1').get(secretService) as {
    subscription_url: string;
  };
  await dispatch(messageUpdateAs(ADMIN, `/users ${BERLIN.id}`, nextId()));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes('🆔'));
  assert.ok(text.includes('💰'));
  assert.ok(text.includes('📦'));
  assert.ok(!text.includes(secretUrl.subscription_url), 'subscription_url never rendered');
  assert.ok(!text.includes('TEST'), 'no token material');
  assert.ok(!text.includes('PG-TEST-KEY'), 'no panel key');
  assert.ok(!text.includes('━━━━'), 'no ASCII divider lines');
  assert.ok(text.length < 4000);
});

test('services distinguish active / expired / panel-deleted; cross-user blocked', async () => {
  stub.reset();
  const cid = customerIdOf(SARA.id);
  insertPurchase({ customerId: cid, name: 'ERRF_ACTIVE', expiresInDays: 20 });
  insertPurchase({ customerId: cid, name: 'ERRF_OLD', expiresInDays: -5 });
  insertPurchase({ customerId: cid, name: 'ERRF_GONE', expiresInDays: 20, deleted: true });
  await dispatch(callbackUpdateAs(`usr:svc:${SARA.id}:0`, nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes('ERRF_ACTIVE'));
  assert.ok(text.includes('ERRF_OLD'));
  assert.ok(text.includes('ERRF_GONE'));
  assert.ok(text.includes(fa.serviceStatusDeleted), 'deleted badge visible');
  assert.ok(text.length < 4000);

  // Cross-user: order of SARA must not open under BERLIN's tgid.
  const foreign = sqlite.prepare(
    `SELECT id FROM orders WHERE customer_id = ?1 AND kind='purchase' AND state='completed' LIMIT 1`,
  ).get(cid) as { id: string };
  await dispatch(callbackUpdateAs(`usr:svcd:${BERLIN.id}:${foreign.id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(lastTextTo(ADMIN.id), fa.invalidChoice);
});

test('orders paginate full history with renewal vs repurchase labels preserved', async () => {
  stub.reset();
  const cid = customerIdOf(BERLIN.id);
  const svc = insertPurchase({ customerId: cid, name: 'ERRF_HIST', expiresInDays: 20 });
  insertRenewal({ customerId: cid, serviceId: svc, repurchase: false });
  const repId = insertRenewal({ customerId: cid, serviceId: svc, repurchase: true, state: 'awaiting_review' });
  await dispatch(callbackUpdateAs(`usr:ord:${BERLIN.id}:0`, nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes(fa.ordersKindRenewal), 'historical renewal label preserved');
  assert.ok(text.includes(fa.ordersKindRepurchase), 'repurchase label distinct');
  assert.ok(text.length < 4000);
  // Order card renders via shared snapshot helpers, no receipt/secrets.
  await dispatch(callbackUpdateAs(`usr:ordd:${BERLIN.id}:${repId}`, nextId(), ADMIN, ADMIN.id));
  const card = lastTextTo(ADMIN.id);
  assert.ok(card.includes(repId));
  assert.ok(!card.includes('SECRET_'), 'no subscription secret in order card');
});

test('wallet view is read-only and points to /credit /debit', async () => {
  stub.reset();
  const { applyWalletMutation } = await import('../src/db/wallet.ts');
  const cid = customerIdOf(BERLIN.id);
  const granted = await applyWalletMutation(db, {
    customerId: cid,
    amountIrt: 500_000,
    kind: 'admin_grant',
    actor: `admin:${ADMIN.id}`,
  });
  assert.equal(granted.ok, true);
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE customer_id = ?1').get(cid) as {
    n: number;
  };
  await dispatch(callbackUpdateAs(`usr:wal:${BERLIN.id}`, nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes('500,000'), 'balance visible');
  assert.ok(text.includes('/credit') && text.includes('/debit'), 'hint to existing flows');
  const afterCount = sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE customer_id = ?1').get(cid) as {
    n: number;
  };
  assert.equal(afterCount.n, before.n, 'viewing wallet writes nothing');
});

test('repurchases are separated; cancel reuses existing adm:cancel only', async () => {
  stub.reset();
  const cid = customerIdOf(SARA.id);
  sqlite.prepare(`DELETE FROM orders WHERE customer_id = ?1 AND kind='renewal'`).run(cid);
  const svc = insertPurchase({ customerId: cid, name: 'ERRF_REP', expiresInDays: -2 });
  const lockId = insertRenewal({ customerId: cid, serviceId: svc, repurchase: true, state: 'awaiting_review' });
  await dispatch(callbackUpdateAs(`usr:rep:${SARA.id}`, nextId(), ADMIN, ADMIN.id));
  const text = lastTextTo(ADMIN.id);
  assert.ok(text.includes(fa.usersRepurchasesHeader));
  assert.ok(text.includes(lockId.slice(0, 10)));
  assert.ok(text.includes(fa.adminRepurchaseLockLine));
  const buttons = buttonsOf(ADMIN.id);
  assert.ok(buttons.includes(`adm:cancel:${lockId}`), 'cancel via existing adm: namespace');
  assert.ok(!buttons.some((b) => b.startsWith('usr:') && b.includes('cancel')), 'no second cancel implementation');

  // The shared core performs the cancel (idempotent, history preserved).
  await dispatch(callbackUpdateAs(`adm:cancel:${lockId}`, nextId(), ADMIN, ADMIN.id));
  const state = (sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(lockId) as { state: string }).state;
  assert.equal(state, 'cancelled');
  const stillThere = sqlite.prepare('SELECT COUNT(*) AS n FROM orders WHERE id = ?1').get(lockId) as { n: number };
  assert.equal(stillThere.n, 1, 'history row preserved');

  // Provisioning-started lock offers no cancel button.
  const svc2 = insertPurchase({ customerId: cid, name: 'ERRF_REP2', expiresInDays: -2 });
  const startedId = insertRenewal({ customerId: cid, serviceId: svc2, repurchase: true, state: 'provisioning' });
  stub.reset();
  await dispatch(callbackUpdateAs(`usr:rep:${SARA.id}`, nextId(), ADMIN, ADMIN.id));
  const buttons2 = buttonsOf(ADMIN.id);
  assert.ok(!buttons2.includes(`adm:cancel:${startedId}`), 'provisioning-started not cancellable');
  assert.ok(lastTextTo(ADMIN.id).includes(fa.adminRepurchaseProvisioningLine));
});

test('usr: parser is strict: hostile payloads rejected', async () => {
  assert.equal(parseUsersCallback('usr:menu')?.action, 'menu');
  assert.equal(parseUsersCallback('usr:list:det:0')?.action, 'list');
  assert.equal(parseUsersCallback(`usr:det:${BERLIN.id}:det:0`)?.action, 'det');
  assert.equal(parseUsersCallback('usr:list:det:-1'), null);
  assert.equal(parseUsersCallback('usr:det:abc:det:0'), null);
  assert.equal(parseUsersCallback('usr:svc:1:2:3'), null);
  assert.equal(parseUsersCallback('usr:wal:0'), null);
  assert.equal(parseUsersCallback('USR:menu'), null);
  assert.equal(isValidCallbackData('usr:list:det:0'), true);
  assert.equal(isValidCallbackData('usr:evil:1'), false);
});

test('regression: existing admin commands and main menu untouched', async () => {
  stub.reset();
  const { MAIN_MENU_ENTRIES } = await import('../src/telegram/menu.ts');
  assert.equal(MAIN_MENU_ENTRIES.length, 10, 'reply keyboard still 10 entries');
  await dispatch(messageUpdateAs(ADMIN, '/pending', nextId()));
  assert.ok(
    [fa.adminQueueHeader, fa.adminQueueEmpty].some((h) => lastTextTo(ADMIN.id).includes(h)),
    '/pending still answers',
  );
  await dispatch(messageUpdateAs(ADMIN, '/repurchases', nextId()));
  assert.ok(
    [fa.adminRepurchaseQueueHeader, fa.adminRepurchaseQueueEmpty].some((h) =>
      lastTextTo(ADMIN.id).includes(h),
    ),
    '/repurchases still answers',
  );
  await dispatch(messageUpdateAs(ADMIN, '/myid', nextId()));
  assert.ok(lastTextTo(ADMIN.id).includes(String(ADMIN.id)), '/myid intact');
});

test('dashboard browsing makes zero PasarGuard calls and stays under the cap', async () => {
  stub.reset();
  stub.panel.reset();
  await dispatch(messageUpdateAs(ADMIN, '/users', nextId()));
  await dispatch(callbackUpdateAs('usr:list:det:0', nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, `/users ${SARA.id}`, nextId()));
  await dispatch(callbackUpdateAs(`usr:svc:${SARA.id}:0`, nextId(), ADMIN, ADMIN.id));
  await dispatch(callbackUpdateAs(`usr:ord:${SARA.id}:0`, nextId(), ADMIN, ADMIN.id));
  await dispatch(callbackUpdateAs(`usr:wal:${SARA.id}`, nextId(), ADMIN, ADMIN.id));
  await dispatch(callbackUpdateAs(`usr:rep:${SARA.id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(stub.panel.calls.length, 0, 'browsing never touches the panel');
  for (const s of stub.sent.filter((m) => m.method === 'sendMessage')) {
    assert.ok(String(s.text).length < 4000, 'every bubble under the cap');
  }
});
