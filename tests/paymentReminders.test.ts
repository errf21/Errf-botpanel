/**
 * Phase 8C e2e: payment review reminders (15/30/45-min cron ladder) plus the
 * card-secret and copy-friendly-value amendments. Real dispatcher over real
 * SQLite migrations (0001-0008) with a stubbed fetch; the sweep is called
 * DIRECTLY with a synthetic wall clock (this repo never fakes timers —
 * explicit `now` args are the established time-control pattern).
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
} from './helpers.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { runPaymentReminderSweep, dueStageFor } = await import('../src/handlers/paymentReminders.ts');
const { claimStage } = await import('../src/db/paymentReminders.ts');
const { fa } = await import('../src/telegram/texts.ts');
const { tgCode } = await import('../src/telegram/format.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const db = shim as unknown as D1Database;
const envRef: Record<string, unknown> = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PAYMENT_CARD_NUMBER: TEST_CARD,
};
const env = envRef as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);
let counter = 8000;
const nextId = () => ++counter;

interface ReminderRow {
  order_id: string;
  created_at: string;
  reminded_stage: number;
}

function reminderRow(orderId: string): ReminderRow | undefined {
  return sqlite
    .prepare('SELECT order_id, created_at, reminded_stage FROM payment_reminders WHERE order_id = ?1')
    .get(orderId) as ReminderRow | undefined;
}

function sessionFor(tgUserId: number): { state: string; data: Record<string, unknown> } {
  const row = sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgUserId)) as { state: string; data: string } | undefined;
  return row
    ? { state: row.state, data: JSON.parse(row.data) as Record<string, unknown> }
    : { state: 'IDLE', data: {} };
}

async function purchaseToSummary(user: typeof USER): Promise<void> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, 'northvalley7', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  await dispatch(callbackUpdateAs('dev:3', nextId(), user));
}

/** Purchase ladder + confirm + photo receipt → awaiting_review with a schedule. */
async function buyWithReceipt(user: typeof USER = USER): Promise<string> {
  await purchaseToSummary(user);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  const orderId = sessionFor(user.id).data['order_id'] as string;
  assert.equal(typeof orderId, 'string');
  assert.equal(sessionFor(user.id).state, 'WAITING_PAYMENT_RECEIPT');
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `REM${nextId()}` }, user));
  return orderId;
}

const messagesTo = (chatId: number) =>
  stub.sent.filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) => messagesTo(chatId).map((s) => String(s.text ?? ''));
const reminderTextsTo = (chatId: number, orderId: string) =>
  textsTo(chatId).filter((t) => t.includes('⏳') && t.includes(orderId));

/** Sweep at `minutes` after the order's schedule anchor. */
async function sweepAfter(anchorIso: string, minutes: number, atMs?: number) {
  return runPaymentReminderSweep(env, atMs ?? Date.parse(anchorIso) + minutes * 60_000);
}

/**
 * Take a leftover awaiting order out of the blast radius (SQL-driven, like
 * the phase6 precedent) so GLOBAL synthetic-clock sweeps stay deterministic.
 */
function retire(orderId: string): void {
  sqlite
    .prepare("UPDATE orders SET state = 'approved' WHERE id = ?1")
    .run(orderId);
}

/* ————————————————————————— schedule creation ————————————————————————— */

test('receipt submission creates exactly one anchored schedule; replay adds nothing', async () => {
  const orderId = await buyWithReceipt();
  const row = reminderRow(orderId);
  assert.ok(row, 'schedule row created with the first receipt');
  assert.equal(row.reminded_stage, 0);
  // anchor ≈ submission time (real clock, one query apart)
  assert.ok(Math.abs(Date.now() - Date.parse(row.created_at)) < 60_000);

  // replacement loses the INSERT OR IGNORE → same row, same t0, same count
  const anchorBefore = row.created_at;
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'REPLACE_1' }));
  const after = reminderRow(orderId);
  assert.equal(after?.created_at, anchorBefore);
  assert.equal(after?.reminded_stage, 0);
  assert.equal(Number(sqlite.prepare('SELECT COUNT(*) n FROM payment_reminders WHERE order_id = ?1').get(orderId)['n']), 1);

  // duplicate webhook replay (same update_id): dedupe catches it; still one schedule
  const replay = mediaUpdate(nextId(), { kind: 'photo', fileId: 'REPLAY_ME' });
  await dispatch(replay);
  await dispatch(replay);
  assert.equal(reminderRow(orderId)?.created_at, anchorBefore);
  retire(orderId);
});

/* ————————————————————————— ladder: 15 / 30 / 45 ————————————————————————— */

test('nothing fires before 15:00 (never early)', async () => {
  const orderId = await buyWithReceipt();
  const row = reminderRow(orderId)!;
  stub.reset();
  await sweepAfter(row.created_at, 14.98);
  assert.equal(reminderTextsTo(USER.id, orderId).length, 0);
  assert.equal(reminderRow(orderId)?.reminded_stage, 0);
  assert.equal(messagesTo(ADMIN.id).length, 0); // no digest when nothing claimed
  retire(orderId);
});

test('stage 1 at 15:00 → one customer nudge + one admin digest; re-run is inert', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  stub.reset();
  const first = await sweepAfter(anchor, 15);
  assert.equal(first.claimed, 1);
  const reminders = reminderTextsTo(USER.id, orderId);
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0]?.startsWith('⏳'));
  assert.ok(reminders[0]?.includes('در حال بررسیه'));
  assert.ok(reminders[0]?.includes('یادآوری برای ادمین'));
  assert.ok(reminders[0]?.includes(orderId));
  const digests = messagesTo(ADMIN.id);
  assert.equal(digests.length, 1);
  assert.ok(String(digests[0]?.text).includes(fa.reminderAdminHeader));
  assert.ok(String(digests[0]?.text).includes(orderId.slice(0, 10)));
  assert.equal(reminderRow(orderId)?.reminded_stage, 1);

  stub.reset();
  const again = await sweepAfter(anchor, 15.5);
  assert.equal(again.claimed, 0);
  assert.equal(stub.sent.length, 0);
  retire(orderId);
});

test('stages 2 and 3 fire once at +30/+45; stage cap after 45min under 10 sweeps', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  await sweepAfter(anchor, 15); // claim stage 1 first
  stub.reset();
  await sweepAfter(anchor, 30);
  let reminders = reminderTextsTo(USER.id, orderId);
  assert.equal(reminders.length, 1); // stage 2 only
  assert.ok(reminders[0] !== fa.reminderCustomer1(orderId));
  assert.equal(reminderRow(orderId)?.reminded_stage, 2);

  stub.reset();
  await sweepAfter(anchor, 45);
  reminders = reminderTextsTo(USER.id, orderId);
  assert.equal(reminders.length, 1); // stage 3 only
  assert.equal(reminderRow(orderId)?.reminded_stage, 3);
  assert.ok(reminders[0] === fa.reminderCustomer3(orderId));

  stub.reset();
  for (let i = 0; i < 10; i++) {
    await sweepAfter(anchor, 46 + i * 12);
  }
  assert.equal(stub.sent.length, 0, 'no stage 4 ever');;
});

test('catch-up at +50min sends exactly the stage-3 nudge (no burst of 1→2→3)', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  stub.reset();
  await sweepAfter(anchor, 50);
  const reminders = reminderTextsTo(USER.id, orderId);
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0]?.includes('طول کشیده'), 'stage-3 variant');
  assert.equal(reminderRow(orderId)?.reminded_stage, 3);
});

test('stale scheduled run (now < anchor) is a total no-op', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  stub.reset();
  const r = await sweepAfter(anchor, -60);
  assert.equal(r.claimed, 0);
  assert.equal(stub.sent.length, 0);
  assert.equal(reminderRow(orderId)?.reminded_stage, 0);
  retire(orderId);
});

/* ————————————————————————— terminal states ————————————————————————— */

test('real approval before the ladder → sweep no-op; stage frozen', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  stub.reset();
  const r = await sweepAfter(anchor, 60);
  assert.equal(r.claimed, 0);
  assert.equal(stub.sent.length, 0);
  assert.equal(reminderRow(orderId)?.reminded_stage, 0);
});

test('reject before the ladder → sweep no-op', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, 'funds not matched', nextId()));
  assert.equal(
    sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(orderId)['state'],
    'rejected',
  );
  stub.reset();
  const r = await sweepAfter(anchor, 60);
  assert.equal(r.claimed, 0);
  assert.equal(reminderRow(orderId)?.reminded_stage, 0);
});

test('SQL-moved terminal states (provisioning/completed/failed/cancelled) never remind', async () => {
  for (const state of ['provisioning', 'completed', 'failed', 'cancelled'] as const) {
    const orderId = await buyWithReceipt();
    const anchor = reminderRow(orderId)!.created_at;
    sqlite.prepare('UPDATE orders SET state = ?2 WHERE id = ?1').run(orderId, state);
    stub.reset();
    const r = await sweepAfter(anchor, 60);
    assert.equal(r.claimed, 0, `${state} must not produce reminders`);
    assert.equal(reminderRow(orderId)?.reminded_stage, 0);
  }
});

test('pending_payment order that never submits a receipt gets nothing', async () => {
  await purchaseToSummary(USER);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const orderId = sessionFor(USER.id).data['order_id'] as string;
  assert.equal(
    sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(orderId)['state'],
    'pending_payment',
  );
  assert.equal(reminderRow(orderId), undefined, 'no schedule before first submission');
  const far = new Date(Date.now() + 24 * 3_600_000).toISOString();
  stub.reset();
  const r = await runPaymentReminderSweep(env, Date.parse(far));
  assert.equal(r.claimed, 0, JSON.stringify(
    sqlite.prepare(
      `SELECT p.order_id, p.reminded_stage, o.state FROM payment_reminders p
         JOIN orders o ON o.id = p.order_id
        WHERE o.state = 'awaiting_review' AND p.reminded_stage < 3`,
    ).all(),
  ));
  assert.equal(stub.sent.length, 0);
});

/* ————————————————————————— claim races ————————————————————————— */

test('two overlapping sweeps claim exactly once', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  const atMs = Date.parse(anchor) + 16 * 60_000;
  stub.reset();
  const [a, b] = await Promise.all([
    runPaymentReminderSweep(env, atMs),
    runPaymentReminderSweep(env, atMs),
  ]);
  assert.equal(a.claimed + b.claimed, 1, 'exactly one winner');
  assert.equal(reminderRow(orderId)?.reminded_stage, 1);
  assert.equal(reminderTextsTo(USER.id, orderId).length, 1);
  assert.equal(messagesTo(ADMIN.id).length, 1, 'only the winner digests');
  retire(orderId);
});

test('claimStage unit: equality guard accepts once, rejects forever after', async () => {
  const orderId = await buyWithReceipt();
  assert.equal(await claimStage(db, orderId, 0, 1), true);
  assert.equal(await claimStage(db, orderId, 0, 1), false);
  assert.equal(await claimStage(db, orderId, 1, 3), true); // advances while eligible
  sqlite.prepare("UPDATE orders SET state = 'approved' WHERE id = ?1").run(orderId);
  assert.equal(await claimStage(db, orderId, 3, 3), false, 'ineligible state fuses into the claim');
});

/* ————————————————————————— replacement semantics ————————————————————————— */

test('replacement keeps the ORIGINAL anchor and never duplicates the schedule', async () => {
  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  await dispatch(mediaUpdate(nextId(), { kind: 'document', fileId: 'SECOND_FILE' }));
  assert.equal(reminderRow(orderId)?.created_at, anchor, 't0 is the FIRST submission');
  const r = await sweepAfter(anchor, 15);
  assert.equal(r.claimed, 1);
  assert.equal(reminderTextsTo(USER.id, orderId).length, 1);
  await sweepAfter(anchor, 30);
  await sweepAfter(anchor, 45);
  stub.reset();
  await sweepAfter(anchor, 120);
  assert.equal(stub.sent.length, 0, 'a replaced order is still capped at 3 total');
});

/* ————————————————————————— wallet paths ————————————————————————— */

test('full-wallet order is structurally unschedulable: no row, total silence', async () => {
  const target = sqlite
    .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
    .get(String(USER.id))['id'] as number;
  sqlite.prepare('UPDATE customers SET balance_irt = 400000 WHERE id = ?1').run(target);
  await purchaseToSummary(USER);
  await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
  const order = sqlite
    .prepare("SELECT id, state FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT 1")
    .get(target) as { id: string; state: string };
  assert.equal(order.state, 'approved'); // born approved — never awaits review
  assert.equal(reminderRow(order.id), undefined);
  stub.reset();
  const r = await sweepAfter(new Date().toISOString(), 60);
  assert.equal(r.claimed, 0);
  assert.equal(reminderTextsTo(USER.id, order.id).length, 0);
});

test('partial-wallet remainder flows the normal ladder; copy quotes only the id', async () => {
  const target = sqlite
    .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
    .get(String(USER.id))['id'] as number;
  sqlite.prepare('UPDATE customers SET balance_irt = 100000 WHERE id = ?1').run(target);
  await purchaseToSummary(USER);
  await dispatch(callbackUpdateAs('wlt:part', nextId(), USER));
  const orderId = sessionFor(USER.id).data['order_id'] as string;
  assert.equal(
    sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(orderId)['state'],
    'pending_payment',
  );
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'PARTIAL_RECEIPT' }));
  assert.ok(reminderRow(orderId), 'remainder order is schedulable');
  const anchor = reminderRow(orderId)!.created_at;
  stub.reset();
  await sweepAfter(anchor, 15);
  const reminders = reminderTextsTo(USER.id, orderId);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0]?.includes('تومان'), false, 'no amounts invented on reminders');
  retire(orderId);
});

/* ————————————————————————— admin digest ————————————————————————— */

test('digest goes to env admin AND is_admin customers, one per run, adm: buttons only', async () => {
  const DBADMIN = { id: 444444444, first_name: 'Mina', username: 'mina_admin2', language_code: 'fa' };
  await dispatch(messageUpdateAs(DBADMIN, '/start', nextId()));
  sqlite.prepare('UPDATE customers SET is_admin = 1 WHERE telegram_user_id = ?1').run(String(DBADMIN.id));

  const first = await buyWithReceipt();
  const second = await buyWithReceipt();
  // Pin BOTH anchors to the same instant (ms gaps would leave 'second' a
  // hair under the 15-minute line) so one sweep claims both together.
  const anchor = reminderRow(first)!.created_at;
  sqlite
    .prepare('UPDATE payment_reminders SET created_at = ?2 WHERE order_id = ?1')
    .run(second, anchor);
  stub.reset();
  const r = await sweepAfter(anchor, 15);
  assert.equal(r.claimed, 2);
  assert.equal(r.adminDigests, 2, 'one consolidated digest per admin chat per run');
  for (const chat of [ADMIN.id, DBADMIN.id]) {
    const digests = messagesTo(chat);
    assert.equal(digests.length, 1);
    const kb = digests[0]?.payload['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][];
    };
    const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(data.includes(`adm:ok:${first}`) && data.includes(`adm:no:${first}`));
    assert.ok(data.includes(`adm:ok:${second}`), 'stale taps answer with the existing notice');
    assert.equal(data.every((d) => d.startsWith('adm:')), true);
    assert.equal(digests[0]?.payload['parse_mode'], undefined, 'digests stay plain text');
  }
  // reviewing straight from the digest works: the approval path is unchanged
  await dispatch(callbackUpdateAs(`adm:ok:${first}`, nextId(), DBADMIN, DBADMIN.id));
  assert.equal(
    sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(first)['state'],
    'approved',
  );
  retire(second);
});

/* ————————————————————————— persona guards ————————————————————————— */

test('persona: three distinct variants, all ⏳-anchored, never any greeting, no parse_mode', async () => {
  const variants = [
    fa.reminderCustomer1('SAMPLEIDXXXXXXXXXXXXXXXXXXXX'),
    fa.reminderCustomer2('SAMPLEIDXXXXXXXXXXXXXXXXXXXX'),
    fa.reminderCustomer3('SAMPLEIDXXXXXXXXXXXXXXXXXXXX'),
  ];
  assert.equal(new Set(variants).size, 3, 'a reminder never repeats itself');
  for (const v of variants) {
    assert.ok(v.startsWith('⏳'));
    assert.equal(v.includes('سلام'), false);
    assert.equal(v.includes('درود'), false);
  }
  assert.ok(variants[1]?.includes('هنوز در انتظار'));
  assert.ok(variants[2]?.includes('هنوز در انتظار'));
  assert.ok(variants[0]?.includes('در حال بررسیه'));
  assert.ok(variants[0]?.includes('یادآوری برای ادمین'));
  assert.ok(variants[0]?.includes('🆔 سفارش:'));
  // receipt confirmations also stay greeting-free (mid-flow bubble)
  assert.equal(fa.receiptAccepted.includes('درود'), false);
  assert.equal(fa.receiptReplaced.includes('درود'), false);
  // asserted stems survived the 8C copy refresh (regression guard)
  assert.ok(fa.receiptAccepted.includes('ثبت شد'), 'ثبت شد stem');
  assert.ok(fa.receiptAccepted.includes('ارسالش کردیم'));
  assert.ok(fa.receiptReplaced.includes('جایگزین شد'));
  assert.ok(fa.receiptReplaced.includes('برای بررسی ارسال شد'));

  const orderId = await buyWithReceipt();
  const anchor = reminderRow(orderId)!.created_at;
  stub.reset();
  await sweepAfter(anchor, 15);
  await sweepAfter(anchor, 30);
  await sweepAfter(anchor, 45);
  for (const s of messagesTo(USER.id)) {
    assert.equal(s.payload['parse_mode'], undefined, 'reminders are plain-text sends');
  }
});

test('dueStageFor: pure monotone clamp, never early, caps at 3, stale-safe', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const m = (n: number) => n * 60_000;
  assert.equal(dueStageFor(t0, t0 + m(14.99)), 0);
  assert.equal(dueStageFor(t0, t0 + m(15)), 1);
  assert.equal(dueStageFor(t0, t0 + m(29.9)), 1);
  assert.equal(dueStageFor(t0, t0 + m(30)), 2);
  assert.equal(dueStageFor(t0, t0 + m(45)), 3);
  assert.equal(dueStageFor(t0, t0 + m(10_000)), 3);
  assert.equal(dueStageFor(t0, t0 - m(5)), 0);
  assert.equal(dueStageFor(NaN, t0), 0);
});

/* ————————————————————————— migration backfill ————————————————————————— */

test('0008 backfill seeds stage from REAL elapsed time (and is re-runnable)', async () => {
  const raw = new DatabaseSync(':memory:');
  for (const file of [
    'migrations/0001_init.sql',
    'migrations/0002_phase2.sql',
    'migrations/0003_phase3.sql',
    'migrations/0004_phase4.sql',
    'migrations/0005_phase5.sql',
    'migrations/0006_phase6.sql',
    'migrations/0007_phase7.sql',
    // Phase 10: the CURRENT sweep reads customers.language — include the
    // (purely additive) locale column in this point-in-time fixture;
    // migration 0008 itself is applied separately below.
    'migrations/0010_phase10.sql',
  ]) {
    raw.exec(readFileSync(`${here}../${file}`, 'utf8'));
  }
  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  raw.exec(`INSERT INTO customers (telegram_user_id) VALUES ('990001'), ('990002'), ('990003');`);
  const seedOrder = (id: string, cust: number, minutesAgo: number) => {
    raw
      .prepare(
        `INSERT INTO orders (id, customer_id, state, selections, amount, updated_at)
         VALUES (?1, ?2, 'awaiting_review', '{}', 1, ?3)`,
      )
      .run(id, cust, iso(minutesAgo));
    raw
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, to_state, created_at)
         VALUES (?1, 'customer', 'receipt_uploaded', 'awaiting_review', ?2)`,
      )
      .run(id, iso(minutesAgo));
  };
  seedOrder('LEGACY60', 1, 60); // fully mature → stage 3 → never reminds again
  seedOrder('LEGACY20', 2, 20); // stage 1 claimed → only stage 2 can come later
  raw
    .prepare(
      `INSERT INTO orders (id, customer_id, state, selections, amount)
       VALUES ('PENDING', 3, 'pending_payment', '{}', 1)`,
    )
    .run();

  const migration = readFileSync(`${here}../migrations/0008_phase8c.sql`, 'utf8');
  raw.exec(migration);
  raw.exec(migration); // re-runnable (deploy retry) — idempotent
  const stage = (id: string) =>
    raw.prepare('SELECT reminded_stage s FROM payment_reminders WHERE order_id = ?1').get(id)['s'];
  assert.equal(stage('LEGACY60'), 3);
  assert.equal(stage('LEGACY20'), 1);
  assert.equal(
    raw.prepare('SELECT COUNT(*) n FROM payment_reminders WHERE order_id = ?1').get('PENDING')['n'],
    0,
    'pending_payment orders are not backfilled',
  );

  // the migrated DB behaves under the sweep: LEGACY20 was seeded mid-ladder
  // (stage 1) — a catch-up run claims ONLY the remaining top stage (3),
  // LEGACY60 is already capped (stage 3 ⇒ not even a candidate row), and no
  // deploy-day burst of 1+2+3 spam happens for anybody.
  const backfillEnv = {
    DB: makeD1Shim(raw),
    TELEGRAM_BOT_TOKEN: 'TEST',
    TELEGRAM_WEBHOOK_SECRET: 'TEST',
  } as unknown as typeof env;
  stub.reset();
  const r = await runPaymentReminderSweep(backfillEnv, Date.now() + 31 * 60_000);
  assert.equal(r.claimed, 1, 'only LEGACY20 advances; LEGACY60 is capped at seed time');
  assert.equal(
    raw.prepare('SELECT reminded_stage s FROM payment_reminders WHERE order_id = ?1').get('LEGACY20')['s'],
    3,
    'catch-up: remaining stages skipped, exactly one message',
  );
  assert.equal(reminderSendsIn('LEGACY20').length, 1);
  assert.equal(reminderSendsIn('LEGACY60').length, 0, 'capped order never sends');
  assert.equal(
    raw.prepare('SELECT reminded_stage s FROM payment_reminders WHERE order_id = ?1').get('LEGACY60')['s'],
    3,
    'capped at seed → remains a non-candidate (claim-less)',
  );
  raw.close();
});

const reminderSendsIn = (needle: string) =>
  stub.sent.filter(
    (s) => s.method === 'sendMessage' && String(s.payload['text'] ?? '').includes(needle),
  );

/* ————————————————————————— card from env + HTML scope ————————————————————————— */

test('card renders ONLY from PAYMENT_CARD_NUMBER; the seeded placeholder never reaches the wire', async () => {
  stub.reset();
  await buyWithReceipt(); // exercises the full instructions bubble
  const instructions = messagesTo(USER.id).find((s) => String(s.text).includes('شماره کارت'));
  assert.ok(instructions);
  assert.ok(String(instructions.text).includes(tgCode(TEST_CARD)));
  assert.equal(instructions.payload['parse_mode'], 'HTML');
  // the legacy settings-doc placeholder card is DEAD: scan every recorded payload
  for (const sent of stub.sent) {
    assert.equal(
      JSON.stringify(sent.payload).includes('6037997100000000'),
      false,
      'placeholder card leaked to the wire',
    );
  }
});

test('secret unset/invalid → fail-closed paymentInfoUnavailable, no card-shaped fallback', async () => {
  for (const bad of ['', '   ', '12', 'not-a-card-number!!']) {
    envRef['PAYMENT_CARD_NUMBER'] = bad;
    stub.reset();
    await purchaseToSummary(USER);
    await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
    const texts = textsTo(USER.id);
    assert.ok(
      texts.some((t) => t.includes('اطلاعات واریز فعلاً در دسترس نیست')),
      `fail-closed text expected for payload ${JSON.stringify(bad)}`,
    );
    assert.equal(texts.some((t) => t.includes('شماره کارت')), false);
    // a receipt can still be submitted afterwards — the flow degrades, never breaks
    envRef['PAYMENT_CARD_NUMBER'] = TEST_CARD;
  }
});

test('doc card_number is ignored even when present (settings doc is never a card source)', async () => {
  sqlite
    .prepare(
      `UPDATE settings
          SET value = json_set(value, '$.card_number', '2222333344445555', '$.holder', 'Ali & <Son>')
        WHERE key = 'payment_info'`,
    )
    .run();
  try {
    stub.reset();
    await purchaseToSummary(USER);
    await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
    const bubble = messagesTo(USER.id).find((s) => String(s.text).includes('شماره کارت'))!;
    assert.ok(bubble);
    const text = String(bubble.text);
    assert.ok(text.includes(tgCode(TEST_CARD)), 'env card shown');
    assert.equal(text.includes('2222333344445555'), false, 'doc card inert');
    assert.ok(text.includes('Ali &amp; &lt;Son&gt;'), 'holder HTML-escaped');
  } finally {
    sqlite
      .prepare(
        `UPDATE settings
            SET value = json_set(value, '$.holder', 'نام صاحب کارت (جای‌نما)')
          WHERE key = 'payment_info'`,
      )
      .run();
  }
});

test('subscription URL renders tap-to-copy, escaped; hint once; detail opts into HTML only then', async () => {
  // find the completed provisioned service created by earlier flows, else forge
  let svc = sqlite
    .prepare(
      `SELECT id, customer_id FROM orders
        WHERE kind = 'purchase' AND state = 'completed' AND subscription_url IS NOT NULL
          AND customer_id = (SELECT id FROM customers WHERE telegram_user_id = ?1)`,
    )
    .get(String(USER.id)) as { id: string; customer_id: number } | undefined;
  if (!svc) {
    const orderId = await purchaseToCompletedWithUrl('https://panel.test/sub/x?a=1&b=2');
    svc = { id: orderId, customer_id: 0 } as { id: string; customer_id: number };
  }
  const url = sqlite
    .prepare('SELECT subscription_url u FROM orders WHERE id = ?1')
    .get(svc.id)['u'] as string;
  stub.reset();
  await dispatch(callbackUpdateAs('menu:services', nextId(), USER));
  await dispatch(callbackUpdateAs(`svc:det:${svc.id}`, nextId(), USER));
  const detail = messagesTo(USER.id).find((s) => String(s.text).includes('🔗 لینک اشتراک:'));
  assert.ok(detail, 'detail bubble with the link line');
  assert.ok(String(detail.text).includes(tgCode(url)), 'URL shown as escaped inline code');
  assert.ok(String(detail.text).includes('&amp;'), 'raw URL carries an escaped &');
  assert.equal(String(detail.text).split(fa.copyHint).length - 1, 1, 'hint once per message');
  assert.equal(detail.payload['parse_mode'], 'HTML');
});

/** Directly move an order to completed with a chosen subscription url. */
async function purchaseToCompletedWithUrl(url: string): Promise<string> {
  const orderId = await buyWithReceipt();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  sqlite
    .prepare(
      `UPDATE orders
          SET state = 'completed', kind = 'purchase', subscription_url = ?2,
              service_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1`,
    )
    .run(orderId, url);
  return orderId;
}

test('admin review bubbles (receipt forward, digest, notices) contain no stray <code> markup', async () => {
  const orderId = await buyWithReceipt(); // submitReceipt forwards with caption
  const forwarded = stub.sent.filter(
    (s) => (s.method === 'sendPhoto' || s.method === 'sendDocument') && Number(s.payload['chat_id']) === ADMIN.id,
  );
  assert.ok(forwarded.length > 0);
  for (const s of forwarded) {
    assert.equal(String(s.payload['caption']).includes('<code>'), false);
    assert.equal(s.payload['parse_mode'], undefined);
  }
  void orderId;
});
