/**
 * Phase 9 e2e: service usage/expiry notification sweep + My Services audit.
 * Real dispatcher + real panel stub (phase6 fake-store pattern) + direct
 * sweep calls with an explicit `now` (the established time-control pattern —
 * clocks stay NEAR real so the lease is exercised in one date domain;
 * windows are moved by mutating service_expires_at, not the clock).
 * Covers: the 0009 suppression backfill, one-shot expiry semantics
 * (3d-or-2d-whichever-first, never both), claim races over overlapping runs,
 * the fresh-lease block + stale-lease retry, the attempts cap, the fused
 * eligibility guard, usage thresholds + byte edge cases, panel-failure
 * classes (404-terminal, 500-transient, unlimited-never), the fail-closed
 * unconfigured-panel leg, copy/persona guards, and discovery of the EXISTING
 * subscription service page (never a built one).
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

const here = fileURLToPath(new URL('.', import.meta.url));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Binary GiB: the same divisor the panel and both display layers use. */
const GB = 1_073_741_824;
const PANEL_KEY = 'PG-SECRET-KEY-42';
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
let panelSeq = 100;
const scenario = { getMode: 'ok' as 'ok' | 'fail500' };

function panelRespond(request: PanelRequest): Response {
  if (scenario.getMode === 'fail500' && request.method === 'GET') {
    return Response.json({ detail: 'panel down' }, { status: 500 });
  }
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
      expire: Number(body['expire'] ?? 0), // ABSOLUTE unix seconds — the 2026-09 wire contract
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

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const {
  runServiceNotificationSweep,
  expiryNoticeDue,
  usageNoticeDecision,
  remainingUntilFa,
  noticeServiceName,
} = await import('../src/handlers/serviceNotifications.ts');
const {
  NOTICE_MAX_ATTEMPTS,
  claimNotice,
  ensurePending,
} = await import('../src/db/serviceNotifications.ts');
const { fa } = await import('../src/telegram/texts.ts');

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
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];
type SweepApi = Parameters<typeof runServiceNotificationSweep>[2];

const deferred: Promise<unknown>[] = [];
const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env, { waitUntil: (p) => deferred.push(p) });
const flush = async (): Promise<void> => {
  while (deferred.length > 0) await Promise.all(deferred.splice(0));
};
let counter = 30000;
const nextId = () => ++counter;

/* ————————————————————————— fixtures ————————————————————————— */

/** buy → receipt → approve → panel provision → completed service. */
async function purchaseToCompleted(): Promise<string> {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'north valley signal', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:3', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `R9_${nextId()}` }, USER));
  const awaiting = sqlite
    .prepare(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.telegram_user_id = ?1 AND o.state = 'awaiting_review'
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(String(USER.id)) as { id: string };
  await dispatch(callbackUpdateAs(`adm:ok:${awaiting.id}`, nextId(), ADMIN, ADMIN.id));
  await flush();
  assert.equal(
    sqlite.prepare('SELECT state s FROM orders WHERE id = ?1').get(awaiting.id)['s'],
    'completed',
  );
  return awaiting.id;
}

function usernameOf(orderId: string): string | null {
  return (sqlite
    .prepare('SELECT pasarguard_username AS v FROM orders WHERE id = ?1')
    .get(orderId) as { v: string | null }).v;
}

function setExpiry(orderId: string, atMs: number): void {
  sqlite
    .prepare('UPDATE orders SET service_expires_at = ?2 WHERE id = ?1')
    .run(orderId, new Date(atMs).toISOString());
}

function setUsage(orderId: string, usedBytes: number, limitBytes: number | null): void {
  const username = usernameOf(orderId);
  assert.ok(username !== null && users.has(username));
  const user = users.get(username as string)!;
  user.used_traffic = usedBytes;
  user.data_limit = limitBytes ?? 0;
}

function noticeRow(orderId: string, kind: string): { status: string; attempts: number } | undefined {
  return sqlite
    .prepare('SELECT status, attempts FROM service_notifications WHERE order_id = ?1 AND kind = ?2')
    .get(orderId, kind) as { status: string; attempts: number } | undefined;
}

/**
 * Force-settle BOTH notice kinds for a service (rows DELETED would resurrect
 * a ≥90% send in a later test's global sweep — 'sent' keeps it terminal).
 */
function retire(orderId: string): void {
  for (const kind of ['usage90', 'expiring'] as const) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO service_notifications (order_id, kind, status) VALUES (?1, ?2, 'sent')`,
      )
      .run(orderId, kind);
    sqlite
      .prepare('UPDATE service_notifications SET status = ?3 WHERE order_id = ?1 AND kind = ?2')
      .run(orderId, kind, 'sent');
  }
}

const noticeSends = () =>
  stub.sent.filter(
    (s) =>
      s.method === 'sendMessage' &&
      Number(s.payload['chat_id']) === USER.id &&
      String(s.text).includes('درود زیبا'),
  );
const usagePanelGets = () =>
  stub.panel.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/user/by-username/'));
const sweep = (nowMs: number, api?: SweepApi) => runServiceNotificationSweep(env, nowMs, api);
const resetAll = () => {
  stub.reset();
  stub.panel.reset();
};

/* ——————————————————————— 0009 migration ——————————————————————— */

test('0009 backfill suppresses deploy-day expiry notices and is re-runnable', () => {
  const raw = new DatabaseSync(':memory:');
  for (const file of [
    'migrations/0001_init.sql', 'migrations/0002_phase2.sql', 'migrations/0003_phase3.sql',
    'migrations/0004_phase4.sql', 'migrations/0005_phase5.sql', 'migrations/0006_phase6.sql',
    'migrations/0007_phase7.sql', 'migrations/0008_phase8c.sql',
  ]) raw.exec(readFileSync(`${here}../${file}`, 'utf8'));
  const iso = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  raw.exec(`INSERT INTO customers (telegram_user_id) VALUES ('991001'), ('991002'), ('991003');`);
  const seed = (
    id: string,
    cust: number,
    expires: string | null,
    state = 'completed',
    kind = 'purchase',
  ) => {
    raw
      .prepare(
        `INSERT INTO orders (id, customer_id, state, kind, selections, amount, service_expires_at)
         VALUES (?1, ?2, ?3, ?4, '{}', 1, ?5)`,
      )
      .run(id, cust, state, kind, expires);
  };
  seed('DUE_IN_WINDOW', 1, iso(1));
  seed('ALREADY_PAST', 2, iso(-4));
  seed('FAR_FUTURE', 3, iso(10));
  seed('UNBOOKED', 1, null);
  seed('NOT_DONE', 2, iso(1), 'failed');
  seed('RENEWAL', 3, iso(1), 'completed', 'renewal');

  const migration = readFileSync(`${here}../migrations/0009_phase9.sql`, 'utf8');
  raw.exec(migration);
  raw.exec(migration); // deploy retry — idempotent

  const statusOf = (id: string): string | undefined =>
    (raw
      .prepare("SELECT status FROM service_notifications WHERE order_id = ?1 AND kind = 'expiring'")
      .get(id) as { status: string } | undefined)?.status;
  assert.equal(statusOf('DUE_IN_WINDOW'), 'sent', 'in-window legacy service is suppressed');
  assert.equal(statusOf('ALREADY_PAST'), 'sent', 'past-expiry legacy service is suppressed');
  assert.equal(statusOf('FAR_FUTURE'), undefined, 'far-future services flow live later');
  assert.equal(statusOf('UNBOOKED'), undefined, 'no expiry bookkeeping = no backfill');
  assert.equal(statusOf('NOT_DONE'), undefined);
  assert.equal(statusOf('RENEWAL'), undefined, 'renewals are not services');
  raw.close();
});

/* ——————————————————————— expiry leg ——————————————————————— */

test('expiry: >3d and already-expired are both silent; the last minute still fires', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 3 * DAY_MS + 40 * HOUR_MS);
  resetAll();
  let r = await sweep(now);
  assert.equal(r.expirySent, 0, 'too early by 40h');
  assert.equal(noticeRow(svc, 'expiring'), undefined, 'no row birthed for non-candidates');

  setExpiry(svc, now - 60_000);
  r = await sweep(now);
  assert.equal(r.expirySent, 0, 'already expired = never the expiry notice');
  assert.equal(noticeRow(svc, 'expiring'), undefined);

  setExpiry(svc, now + 59 * 60_000);
  r = await sweep(now);
  assert.equal(r.expirySent, 1, 'inside the window fires exactly once');
  assert.equal(noticeSends().length, 1, 'and it is the only notice');
  assert.equal((await sweep(now + 5 * 60_000)).expirySent, 0);
  retire(svc);
});

test('expiry: one notice per service; the 2-day line never re-fires', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 2 * DAY_MS + 12 * HOUR_MS);
  resetAll();
  const first = await sweep(now);
  assert.equal(first.expirySent, 1);
  const sends = noticeSends();
  assert.equal(sends.length, 1);
  const text = String(sends[0].text);
  assert.ok(text.startsWith('درود زیبا،'));
  assert.ok(text.includes('⏳'));
  assert.ok(text.includes('«north valley signal»'));
  assert.ok(text.includes('2 روز و 12 ساعت'));
  assert.ok(text.includes('تمدید'), 'renewal is the point of the notice');
  assert.equal(/[۰-۹٬]/.test(text), false, 'display uses English digits only');
  const expiresIso = new Date(now + 2 * DAY_MS + 12 * HOUR_MS).toISOString();
  const timeFa = `${expiresIso.slice(0, 10)} ${expiresIso.slice(11, 16)}`;
  assert.ok(text.includes(timeFa), 'expiry date AND time in the notice');
  assert.equal(sends[0].payload['parse_mode'], undefined, 'notices stay plain text');
  const kb = sends[0].payload['reply_markup'] as {
    inline_keyboard: { callback_data?: string; url?: string }[][];
  };
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === `svc:det:${svc}`), 'view-this-service CTA');
  assert.ok(flat.some((b) => b.callback_data === 'menu:services'));
  assert.ok(flat.every((b) => b.url === undefined), 'notices carry no invented page URLs');

  resetAll();
  const second = await sweep(now + 30 * HOUR_MS); // ~1d left: past the 2-day line
  assert.equal(second.expirySent, 0, 'crossing the 2-day line sends NOTHING new');
  assert.equal(noticeSends().length, 0);
  assert.equal(noticeRow(svc, 'expiring')?.status, 'sent');
  retire(svc);
});

test('expiry: stale clock (before the window) is a total no-op', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 2.9 * DAY_MS);
  resetAll();
  const r = await sweep(now - 5 * DAY_MS);
  assert.equal(r.expirySent, 0);
  assert.equal(noticeSends().length, 0);
  assert.equal(noticeRow(svc, 'expiring'), undefined);
  retire(svc);
});

test('expiry: two overlapping sweeps send exactly one notice', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 2 * DAY_MS);
  resetAll();
  const [a, b] = await Promise.all([sweep(now), sweep(now)]);
  assert.equal(a.expirySent + b.expirySent, 1, 'exactly one winner');
  assert.equal(noticeSends().length, 1);
  retire(svc);
});

test('lease: a fresh sending row is never stolen; a stale lease retries once', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 2 * DAY_MS);
  await ensurePending(db, svc, 'expiring');
  assert.equal(
    await claimNotice(db, { orderId: svc, kind: 'expiring', nowIso: new Date(now).toISOString() }),
    true,
  );
  resetAll();
  const during = await sweep(now + 10 * 60_000); // well inside the 30-min lease
  assert.equal(during.expirySent, 0);
  assert.equal(noticeSends().length, 0, 'a live lease is NOT stolen mid-flight');
  assert.equal(noticeRow(svc, 'expiring')?.status, 'sending');

  resetAll();
  const after = await sweep(now + 31 * 60_000);
  assert.equal(after.expirySent, 1, 'the expired lease is re-claimable exactly once');
  assert.equal(noticeSends().length, 1);
  assert.equal(noticeRow(svc, 'expiring')?.status, 'sent');
  retire(svc);
});

test('send failure: retried per run, terminal failed at the cap, never loops', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + 2 * DAY_MS);
  const alwaysFail = {
    async sendMessage() {
      return null; // the established TelegramApi failure signal
    },
    async sendPhoto() {
      return false;
    },
    async sendDocument() {
      return false;
    },
    async editMessageText() {
      return false;
    },
    async editMessageCaption() {
      return false;
    },
    async answerCallbackQuery() {},
  } as unknown as NonNullable<SweepApi>;
  resetAll();
  for (let i = 0; i < NOTICE_MAX_ATTEMPTS; i++) {
    const r = await sweep(now, alwaysFail);
    assert.equal(r.sendFailed, 1, `retry ${i + 1}`);
  }
  assert.equal(noticeRow(svc, 'expiring')?.status, 'failed', 'rests terminal at the cap');
  assert.equal(noticeRow(svc, 'expiring')?.attempts, NOTICE_MAX_ATTEMPTS);
  resetAll();
  const after = await sweep(now, alwaysFail);
  assert.equal(after.sendFailed, 0);
  assert.equal(after.expirySent, 0, 'terminal failed = out of the candidate set');
  retire(svc);
});

test('fused eligibility: a claim loses when the service leaves the window', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 0, 10 * GB);
  setExpiry(svc, now + DAY_MS);
  await ensurePending(db, svc, 'expiring');
  setExpiry(svc, now + 30 * DAY_MS); // renewal booked forward between list and claim
  const won = await claimNotice(db, {
    orderId: svc,
    kind: 'expiring',
    nowIso: new Date(now).toISOString(),
  });
  assert.equal(won, false, 'the window is re-checked inside the claim itself');
  assert.equal(noticeRow(svc, 'expiring')?.status, 'pending');
  resetAll();
  assert.equal((await sweep(now)).expirySent, 0, 'and it is no longer even a candidate');
  retire(svc);
});

/* ——————————————————————— usage leg ——————————————————————— */

test('usage: exact 90% fires once with honest copy; 89.9% stays silent + backs off', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, Math.floor(0.9 * 10 * GB), 10 * GB);
  setExpiry(svc, now + 30 * DAY_MS);
  resetAll();
  const first = await sweep(now);
  assert.equal(first.usageSent, 1);
  const sends = noticeSends();
  assert.equal(sends.length, 1);
  const text = String(sends[0].text);
  assert.ok(text.startsWith('درود زیبا،'));
  assert.ok(text.includes('📊'));
  assert.ok(text.includes('«north valley signal»'));
  assert.ok(text.includes(`${90}٪`));
  assert.ok(text.includes(`${1} گیگ`), 'explicit remaining volume');
  assert.ok(text.includes('محدود (حجم)'), 'panel-contract wording, no invented cutoff promise');
  assert.ok(
    text.includes('تمدیدِ مدت حجم تازه اضافه نمی‌کند'),
    'the honest Phase 6 renewal fact stays in the copy',
  );
  assert.equal(text.includes('قطع'), false, 'volume notices never promise disconnection');
  assert.equal(sends[0].payload['parse_mode'], undefined);
  const kb = sends[0].payload['reply_markup'] as {
    inline_keyboard: { callback_data?: string; url?: string }[][];
  };
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === `svc:det:${svc}`));
  assert.ok(flat.every((b) => b.url === undefined), 'notices carry no invented page URLs');

  resetAll();
  const again = await sweep(now + 2 * HOUR_MS);
  assert.equal(again.usageSent, 0);
  assert.equal(usagePanelGets().length, 0, 'settled row leaves the candidate set forever');
  retire(svc);

  const svc2 = await purchaseToCompleted();
  setUsage(svc2, Math.floor(8.99 * GB), 10 * GB);
  setExpiry(svc2, now + 30 * DAY_MS);
  resetAll();
  const r2 = await sweep(now + DAY_MS);
  assert.equal(r2.usageSent, 0);
  assert.equal(noticeSends().length, 0);
  assert.equal(usagePanelGets().length, 1, 'polled once');
  assert.equal(noticeRow(svc2, 'usage90')?.status, 'pending', 'not-yet rests in backoff');
  assert.equal(noticeRow(svc2, 'usage90')?.attempts, 0, 'a below-threshold answer is not an attempt');
  await sweep(now + DAY_MS + 10 * 60_000);
  assert.equal(usagePanelGets().length, 1, 'not re-polled inside the backoff window');
  await sweep(now + DAY_MS + 61 * 60_000);
  assert.equal(usagePanelGets().length, 2, 'backoff expired -> polled again');
  retire(svc2);
});

test('usage: over-100% usage is notified with a clamped percent', async () => {
  const svc = await purchaseToCompleted();
  setUsage(svc, 12 * GB, 10 * GB);
  setExpiry(svc, Date.now() + 30 * DAY_MS);
  resetAll();
  const r = await sweep(Date.now());
  assert.equal(r.usageSent, 1);
  const text = String(noticeSends()[0].text);
  assert.ok(text.includes('99٪'), 'never a ۱۰۵٪ boast');
  assert.equal(text.includes('105'), false);
  assert.ok(text.includes('0 گیگ'), 'remaining floors at ۰, never negative');
  retire(svc);
});

test('usage: unlimited plans and unknown usage never fire', async () => {
  const svc = await purchaseToCompleted();
  setUsage(svc, 123 * GB, null); // data_limit 0 -> the client reads it as unlimited
  setExpiry(svc, Date.now() + 30 * DAY_MS);
  resetAll();
  const first = await sweep(Date.now());
  assert.equal(first.usageSent, 0);
  assert.equal(noticeSends().length, 0);
  assert.equal(noticeRow(svc, 'usage90')?.status, 'pending', 'not an error, just not evaluable');
  retire(svc);
});

test('usage: panel 404 skips the notice terminally — no poll loop', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 9.5 * GB, 10 * GB);
  setExpiry(svc, now + 30 * DAY_MS);
  users.delete(usernameOf(svc) as string); // genuinely deleted on the panel
  resetAll();
  const r = await sweep(now);
  assert.equal(r.usageSent, 0);
  assert.equal(r.skipped, 1);
  assert.equal(noticeRow(svc, 'usage90')?.status, 'skipped');
  resetAll();
  await sweep(now + 2 * DAY_MS);
  assert.equal(usagePanelGets().length, 0, 'skipped services are never re-polled');
  users.set(usernameOf(svc) as string, {
    id: '999', username: usernameOf(svc) as string, status: 'active',
    subscription_url: '/sub/x', expire: 0, data_limit: 10 * GB, used_traffic: 9.5 * GB,
  }); // restore the map entry for other helpers
  retire(svc);
});

test('usage: expired panel status is terminal too (nothing left to warn about)', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 9.5 * GB, 10 * GB);
  setExpiry(svc, now + 30 * DAY_MS); // local bookkeeping stale vs the panel
  users.get(usernameOf(svc) as string)!.status = 'expired';
  resetAll();
  const r = await sweep(now);
  assert.equal(r.usageSent, 0);
  assert.equal(r.skipped, 1);
  resetAll();
  await sweep(now + 2 * DAY_MS);
  assert.equal(usagePanelGets().length, 0);
  users.get(usernameOf(svc) as string)!.status = 'active';
  retire(svc);
});

test('usage: transient panel errors touch only the backoff stamp, then self-heal', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 9.5 * GB, 10 * GB);
  setExpiry(svc, now + 30 * DAY_MS);
  scenario.getMode = 'fail500';
  resetAll();
  const r = await sweep(now);
  assert.equal(r.usageSent, 0);
  assert.equal(r.sendFailed, 0);
  assert.equal(r.skipped, 0, 'an outage is NOT terminal');
  assert.equal(noticeRow(svc, 'usage90')?.status, 'pending', 'backoff stamp only');
  assert.equal(noticeRow(svc, 'usage90')?.attempts, 0, 'a panel outage is not an attempt');
  scenario.getMode = 'ok';

  resetAll();
  const recovered = await sweep(now + 61 * 60_000);
  assert.equal(usagePanelGets().length, 1, 're-polled after the backoff window');
  assert.equal(recovered.usageSent, 1, 'and the notice still gets delivered');
  assert.equal(noticeSends().length, 1);
  retire(svc);
});

test('usage leg fails closed without panel config; the expiry leg is unaffected', async () => {
  const svc = await purchaseToCompleted();
  setUsage(svc, 9.9 * GB, 10 * GB);
  setExpiry(svc, Date.now() + DAY_MS);
  const bareEnv = { ...env } as Record<string, unknown>;
  delete bareEnv['PASARGUARD_API_KEY'];
  resetAll();
  const r = await runServiceNotificationSweep(bareEnv as unknown as typeof env, Date.now());
  assert.equal(r.usageSent, 0);
  assert.equal(r.expirySent, 1, 'the expiry leg never depends on the panel');
  assert.equal(stub.panel.calls.length, 0, 'zero panel traffic when unconfigured');
  retire(svc);
});

/* ——————————————————————— pure gates ——————————————————————— */

test('expiryNoticeDue: exact inclusive upper bound, never past, never NaN', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(expiryNoticeDue(new Date(now + 2 * DAY_MS).toISOString(), now), true);
  assert.equal(expiryNoticeDue(new Date(now + 3 * DAY_MS).toISOString(), now), true);
  assert.equal(expiryNoticeDue(new Date(now + 3 * DAY_MS + 1).toISOString(), now), false);
  assert.equal(expiryNoticeDue(new Date(now).toISOString(), now), false, 'the expiry instant is past');
  assert.equal(expiryNoticeDue(new Date(now - 1).toISOString(), now), false);
  assert.equal(expiryNoticeDue('garbage', now), false);
  assert.equal(expiryNoticeDue(null, now), false);
  assert.equal(expiryNoticeDue(new Date(now + DAY_MS).toISOString(), NaN), false);
});

test('usageNoticeDecision: null/zero caps are never-evaluable, the boundary is exact', () => {
  assert.deepEqual(usageNoticeDecision(9 * GB, 10 * GB), { kind: 'due', percent: 90, remainingGb: 1 });
  assert.deepEqual(usageNoticeDecision(Math.floor(0.899 * 10 * GB), 10 * GB), { kind: 'not_yet' });
  assert.deepEqual(usageNoticeDecision(null, 10 * GB), { kind: 'not_evaluable' });
  assert.deepEqual(usageNoticeDecision(9 * GB, null), { kind: 'not_evaluable' });
  assert.deepEqual(usageNoticeDecision(9 * GB, 0), { kind: 'not_evaluable' });
  assert.equal(usageNoticeDecision(12 * GB, 10 * GB).kind, 'due');
});

test('remainingUntilFa & noticeServiceName: shapes and hostile input', () => {
  const base = Date.UTC(2026, 0, 1, 12);
  const isoIn = (ms: number) => new Date(base + ms).toISOString();
  assert.equal(remainingUntilFa(isoIn(DAY_MS + HOUR_MS), base), '1 روز و 1 ساعت');
  assert.equal(remainingUntilFa(isoIn(2 * DAY_MS), base), '2 روز');
  assert.equal(remainingUntilFa(isoIn(3 * HOUR_MS), base), '3 ساعت');
  assert.equal(remainingUntilFa(isoIn(40_000), base), 'کمتر از یک ساعت');
  assert.equal(remainingUntilFa(isoIn(-DAY_MS), base), 'کمتر از یک ساعت', 'never negative');
  const d3 = remainingUntilFa(isoIn(3 * DAY_MS - 1000), base);
  assert.ok(d3.includes('2 روز') && d3.includes('23 ساعت'), 'never says ۳ and still be inside');
  assert.equal(noticeServiceName('{"config_name":"north valley signal"}'), 'north valley signal');
  assert.equal(noticeServiceName('not json'), 'سرویس شما');
  assert.equal(noticeServiceName('[1,2,3]'), 'سرویس شما');
  assert.equal(noticeServiceName('{}'), 'سرویس شما');
  const sanitized = noticeServiceName(JSON.stringify({ config_name: 'evil\u001bname\nx\rend' }));
  assert.equal(sanitized.includes('\u001b'), false);
  assert.equal(sanitized.includes('\n'), false);
  assert.equal(sanitized.includes('\r'), false);
  assert.equal(noticeServiceName(JSON.stringify({ config_name: 'x'.repeat(200) })).length, 64);
});

test('persona: both notices open «درود زیبا،», never carry «سلام»', () => {
  for (const text of [
    fa.usageNotice('north valley signal', '90', '1'),
    fa.expiryNotice('north valley signal', '2 روز', '2027-01-01 00:00'),
  ]) {
    assert.ok(text.startsWith('درود زیبا،'));
    assert.equal(text.includes('سلام'), false);
    assert.equal(text.includes('<'), false, 'no markup in plain-text notices');
  }
  assert.equal(fa.receiptAccepted.includes('درود'), false, 'mid-flow bubble stays greeting-free');
});

/* —————————————————— audit + discovery surfaces —————————————————— */

test('provisioning success message carries the service-page discovery line + URL CTA', async () => {
  const svc = await purchaseToCompleted();
  const ready = stub.sent.find((s) => String(s.text).includes('ساخته و فعال شد'))!;
  assert.ok(ready);
  assert.ok(String(ready.text).includes('صفحه‌ی اختصاصی سرویس'), 'explicit page mention');
  assert.equal(ready.payload['parse_mode'], 'HTML', 'the URL stays tap-to-copy code there');
  const kb = ready.payload['reply_markup'] as {
    inline_keyboard: { url?: string; callback_data?: string }[][];
  };
  const flat = kb.inline_keyboard.flat();
  assert.ok(
    flat.some((b) => typeof b.url === 'string' && b.url.startsWith(`${PANEL_BASE}/sub/`)),
    'opens the EXISTING panel page (its relative URL was resolved at provisioning)',
  );
  assert.ok(flat.some((b) => b.callback_data === 'menu:services'));
  assert.ok(flat.every((b) => typeof b.url === 'string' || typeof b.callback_data === 'string'));
  retire(svc);
});

test('detail & list audit: names in list, expiry time, used/remaining, page note/CTA, degrade hint', async () => {
  const svc = await purchaseToCompleted();
  setUsage(svc, 4 * GB, 10 * GB);
  const username = usernameOf(svc) as string;
  const panelExpireIso = new Date(users.get(username)!.expire * 1000).toISOString();
  const timeFa = `${panelExpireIso.slice(0, 10)} ${panelExpireIso.slice(11, 16)}`;
  resetAll();
  await dispatch(callbackUpdateAs('menu:services', nextId(), USER));
  const list = (stub.sent.find((s) => String(s.text).includes(fa.servicesHeader))?.text) ?? '';
  assert.ok(String(list).includes('📦 north valley signal'), 'list entries name their service');

  resetAll();
  await dispatch(callbackUpdateAs(`svc:ref:${svc}`, nextId(), USER)); // live read on first tap
  const edited = stub.sent.filter((s) => s.method === 'editMessageText').at(-1)!;
  assert.ok(edited, 'detail edited in place');
  const text = String(edited.payload['text']);
  assert.ok(text.includes(timeFa), 'expiry shows date AND time');
  assert.ok(text.includes(fa.svcUsage('4', '10')), 'used X of Y');
  assert.ok(text.includes(fa.svcRemaining('6')), 'explicit remaining volume');
  assert.ok(text.includes(fa.svcPageNote), 'page discovery note next to the link');
  assert.ok(!text.includes(fa.svcUsageHintSnapshot), 'no hint while the panel answers');
  const kb = edited.payload['reply_markup'] as {
    inline_keyboard: { url?: string; callback_data?: string }[][];
  };
  assert.ok(kb.inline_keyboard.flat().some((b) => typeof b.url === 'string'), 'open-page CTA button');
  assert.equal(edited.payload['parse_mode'], 'HTML');

  scenario.getMode = 'fail500';
  resetAll();
  await dispatch(callbackUpdateAs(`svc:ref:${svc}`, nextId(), USER));
  const degraded = stub.sent.filter((s) => s.method === 'editMessageText').at(-1)!;
  const dtext = String(degraded.payload['text']);
  assert.ok(dtext.includes(fa.svcUsageHintSnapshot), 'degrade points at refresh, not silence');
  assert.ok(dtext.includes(fa.svcSnapshotNote), 'the pre-existing degrade note survives');
  scenario.getMode = 'ok';

  resetAll();
  await dispatch(callbackUpdateAs(`svc:det:${svc}`, nextId(), USER)); // snapshot-only render
  const det = (stub.sent.find((s) => s.method === 'sendMessage')?.text) ?? '';
  assert.ok(String(det).includes(fa.svcUsageHintSnapshot), 'first-look detail is honest about usage too');
  retire(svc);
});

test('notices for both kinds coexist for one service and never interfere', async () => {
  const svc = await purchaseToCompleted();
  const now = Date.now();
  setUsage(svc, 9.2 * GB, 10 * GB);
  setExpiry(svc, now + 20 * HOUR_MS);
  resetAll();
  const r = await sweep(now);
  assert.equal(r.usageSent, 1);
  assert.equal(r.expirySent, 1);
  assert.equal(noticeSends().length, 2);
  assert.equal(noticeSends().filter((s) => String(s.text).includes('📊')).length, 1);
  assert.equal(noticeSends().filter((s) => String(s.text).includes('⏳')).length, 1);
  retire(svc);
});

test('cross-phase isolation: the service sweep never touches payment_reminders', async () => {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'sunset ridge beacon', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:1', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `X9_${nextId()}` }, USER));
  const pending = sqlite
    .prepare("SELECT id FROM orders WHERE state='awaiting_review' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string };
  const rowsBefore = (sqlite.prepare('SELECT COUNT(*) n FROM payment_reminders').get() as { n: number }).n;
  assert.ok(rowsBefore >= 1, 'the 8C anchor row exists to be left alone');
  resetAll();
  const r = await sweep(Date.now());
  assert.equal(r.expirySent, 0);
  assert.equal(r.usageSent, 0);
  assert.equal(stub.sent.length, 0, 'silent run: a pending receipt is no notice trigger');
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) n FROM payment_reminders').get() as { n: number }).n,
    rowsBefore,
  );
  sqlite.prepare('UPDATE payment_reminders SET reminded_stage = 3 WHERE order_id = ?1').run(pending.id);
});
