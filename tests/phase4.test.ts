/**
 * Phase 4 e2e: payment receipt submission + ADMIN manual approval, on the
 * real dispatcher over real SQLite migrations (0001-0004) with a stubbed
 * fetch (no network, no Telegram, no PasarGuard — none is allowed here).
 * Covers: receipt upload/replacement, admin forwarding, approve/reject with
 * reason prompt + skip, double-tap/race guards, forgery + non-admin blocks,
 * env ADMIN_CHAT_ID gate, /pending queue, customer orders view.
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
} from './helpers.ts';
import { newOrderId } from '../src/lib/security.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

let counter = 4000;
const nextId = () => ++counter;

interface OrderRow {
  id: string;
  customer_id: number;
  state: string;
  selections: string;
  amount: number;
  currency: string;
  receipt_file_id: string | null;
  payment_reference: string | null;
  verified_by: string | null;
  verified_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

function orderById(id: string): OrderRow | undefined {
  return sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as
    | OrderRow
    | undefined;
}

function eventsOf(id: string): Array<{ actor: string; action: string; from_state: string; to_state: string; data: string | null }> {
  return sqlite
    .prepare('SELECT actor, action, from_state, to_state, data FROM order_events WHERE order_id = ?1 ORDER BY id')
    .all(id) as Array<{ actor: string; action: string; from_state: string; to_state: string; data: string | null }>;
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

const sends = () => stub.sendCalls();
const callsFor = (method: string) => stub.sent.filter((s) => s.method === method);
const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);

/** Full P3 purchase for `user`, ending in WAITING_PAYMENT_RECEIPT. Returns order id. */
async function purchase(user: typeof USER = USER): Promise<string> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, `north valley signal`, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  await dispatch(callbackUpdateAs('dev:3', nextId(), user));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  const session = sessionFor(user.id);
  assert.equal(session.state, 'WAITING_PAYMENT_RECEIPT');
  const orderId = session.data['order_id'];
  assert.equal(typeof orderId, 'string');
  return orderId as string;
}

test('payment instructions arrive right after confirmation', async () => {
  stub.reset();
  const orderId = await purchase();
  assert.equal(orderById(orderId)?.state, 'pending_payment');
  const texts = sends().map((s) => String(s.text));
  assert.ok(texts.some((t) => t.includes('سفارش شما ثبت شد')));
  const instructions = sends().find((s) => String(s.text).includes('شماره کارت'));
  assert.ok(instructions, 'payment instructions message expected');
  // Phase 8C: the card is the env secret, shown as tap-to-copy inline code —
  // and the seeded placeholder in the settings doc never reaches the wire.
  assert.equal(instructions.payload['parse_mode'], 'HTML');
  assert.ok(String(instructions.text).includes(`<code>${TEST_CARD}</code>`));
  assert.equal(String(instructions.text).includes('6037997100000000'), false);
  assert.ok(String(instructions.text).includes('(یک بار بزن روی مقدار، کپی می‌شه)')); // hint once
  assert.equal(
    String(instructions.text).split('(یک بار بزن روی مقدار، کپی می‌شه)').length - 1,
    1,
  );
  assert.ok(String(instructions.text).includes('تومان')); // formatted amount
  assert.ok(String(instructions.text).includes('فیش'));
});

let mainOrderId = '';

test('photo receipt → awaiting_review + forwarded to admin with buttons', async () => {
  mainOrderId = sessionFor(USER.id).data['order_id'] as string;
  assert.ok(mainOrderId);
  const orderId = mainOrderId;

  stub.reset();
  await dispatch(
    mediaUpdate(nextId(), {
      kind: 'photo',
      fileId: 'RECEIPT_PHOTO_MAIN',
      caption: 'کد پیگیری ۱۲۳۴۵',
    }),
  );

  const order = orderById(orderId);
  assert.equal(order?.state, 'awaiting_review');
  assert.equal(order?.receipt_file_id, 'RECEIPT_PHOTO_MAIN'); // largest rendition
  assert.equal(order?.payment_reference, 'کد پیگیری ۱۲۳۴۵');
  assert.ok(eventsOf(orderId).some((e) => e.action === 'receipt_uploaded'));

  // forwarded ONLY to the admin chat — no admin registered yet → nothing sent
  assert.deepEqual(sentTo(ADMIN.id), []);
  // customer confirmation notice (state preserved)
  assert.equal(sessionFor(USER.id).state, 'WAITING_PAYMENT_RECEIPT');
  assert.ok(sends().some((s) => String(s.text).includes('برای بررسی ارسال گردید')));
});

test('ADMIN_CHAT_ID env alone authorizes + receives the forward', async () => {
  const orderId = mainOrderId;
  const prevEnv = env as unknown as Record<string, unknown>;
  prevEnv['ADMIN_CHAT_ID'] = String(ADMIN.id);
  try {
    stub.reset();
    await dispatch(
      mediaUpdate(nextId(), { kind: 'photo', fileId: 'RECEIPT_SECOND' }),
    );
    const order = orderById(orderId);
    assert.equal(order?.receipt_file_id, 'RECEIPT_SECOND'); // replaced
    assert.ok(eventsOf(orderId).some((e) => e.action === 'receipt_replaced'));

    const forwarded = callsFor('sendPhoto').find(
      (s) => Number(s.payload['chat_id']) === ADMIN.id,
    );
    assert.ok(forwarded, 'receipt forwarded to env admin chat');
    assert.equal(forwarded?.payload['photo'], 'RECEIPT_SECOND');
    assert.ok(String(forwarded?.payload['caption']).includes(orderId));
    const kb = forwarded?.payload['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][];
    };
    assert.ok(
      kb.inline_keyboard.flat().some((b) => b.callback_data === `adm:ok:${orderId}`),
    );
    assert.ok(
      kb.inline_keyboard.flat().some((b) => b.callback_data === `adm:no:${orderId}`),
    );
    assert.ok(sends().some((s) => String(s.text).includes('جایگزین شد')));
  } finally {
    delete prevEnv['ADMIN_CHAT_ID'];
  }
});

test('non-admin forgery of adm: callbacks is a no-op; unknown formats inert', async () => {
  const orderId = mainOrderId;
  stub.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), USER));
  assert.equal(orderById(orderId)?.state, 'awaiting_review'); // unchanged
  assert.ok(
    stub.sent.some(
      (s) => s.method === 'answerCallbackQuery' && String(s.payload['text']).includes('نامعتبر'),
    ),
  );
  assert.equal(eventsOf(orderId).some((e) => e.actor.startsWith('admin:')), false);

  // forged ULID outside the Crockford alphabet: rejected at format layer
  const evil = 'adm:ok:' + 'I'.repeat(28);
  await dispatch(callbackUpdateAs(evil, nextId(), USER));
  assert.equal(orderById(orderId)?.state, 'awaiting_review');
});

test('/pending is admin-only; queue shows awaiting orders with buttons', async () => {
  const orderId = mainOrderId;

  stub.reset();
  await dispatch(messageUpdateAs(USER, '/pending', nextId()));
  assert.ok(sends().some((s) => String(s.text).includes('دسترس')));
  assert.equal(callsFor('sendMessage').some((s) => String(s.text).includes(orderId)), false);

  // register the user who will act as admin (env admin id), then query
  prevAdminEnv();
  try {
    stub.reset();
    await dispatch(messageUpdateAs(ADMIN, '/pending', nextId()));
    const queue = sends().find((s) => String(s.text).includes('در انتظار بررسی'));
    assert.ok(queue);
    assert.ok(String(queue.text).includes(orderId));
    const kb = queue.payload['reply_markup'] as {
      inline_keyboard: { callback_data: string }[][];
    };
    assert.deepEqual(kb.inline_keyboard[0]?.map((b) => b.callback_data), [
      `adm:ok:${orderId}`,
      `adm:no:${orderId}`,
    ]);
  } finally {
    clearAdminEnv();
  }
});

const envRef = env as unknown as Record<string, unknown>;
function prevAdminEnv(): void {
  envRef['ADMIN_CHAT_ID'] = String(ADMIN.id);
}
function clearAdminEnv(): void {
  delete envRef['ADMIN_CHAT_ID'];
}

test('admin approves from the forwarded message: state, audit, notices, button kill', async () => {
  const orderId = mainOrderId;
  prevAdminEnv();
  try {
    stub.reset();
    await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));

    const order = orderById(orderId);
    assert.equal(order?.state, 'approved');
    assert.equal(order?.verified_by, String(ADMIN.id));
    assert.ok(order?.verified_at);
    const approved = eventsOf(orderId).filter((e) => e.action === 'payment_approved');
    assert.equal(approved.length, 1);
    assert.equal(approved[0]?.actor, `admin:${ADMIN.id}`);
    assert.equal(approved[0]?.to_state, 'approved');

    // customer session is over; customer got the good news with the order id
    assert.equal(sessionFor(USER.id).state, 'IDLE');
    assert.ok(
      sentTo(USER.id)
        .find((s) => s.method === 'sendMessage')
        && sentTo(USER.id).some((s) => String(s.text).includes('تأیید شد') && String(s.text).includes(orderId)),
    );

    // the admin message that carried buttons was retired (caption → text chain)
    const captionEdits = callsFor('editMessageCaption');
    assert.equal(captionEdits.length, 1);
    assert.ok(String(captionEdits[0]?.payload['caption']).includes(orderId));
  } finally {
    clearAdminEnv();
  }
});

test('double approval cannot re-apply or re-notify', async () => {
  const orderId = mainOrderId;
  const eventsBefore = eventsOf(orderId).length;
  prevAdminEnv();
  try {
    stub.reset();
    const cbId = nextId();
    await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, cbId, ADMIN, ADMIN.id));
    assert.equal(eventsOf(orderId).length, eventsBefore); // zero writes after guard
    assert.ok(
      stub.sent.some(
        (s) => s.method === 'answerCallbackQuery' && String(s.payload['text']).includes('بررسی شده'),
      ),
    );
    assert.equal(sentTo(USER.id).length, 0); // customer NOT re-notified
  } finally {
    clearAdminEnv();
  }
});

test('reject with reason: prompt → text reason on the customer order', async () => {
  const orderId = await purchase();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'REJECT_SHOT' }));
  assert.equal(orderById(orderId)?.state, 'awaiting_review');

  prevAdminEnv();
  try {
    stub.reset();
    await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));

    const pending = sqlite
      .prepare('SELECT order_id, action FROM admin_actions WHERE admin_user_id = ?1')
      .get(String(ADMIN.id)) as { order_id: string; action: string } | undefined;
    assert.equal(pending?.order_id, orderId);
    assert.equal(pending?.action, 'reject');
    const prompt = sends().find((s) => String(s.text).includes('دلیل رد'));
    assert.ok(prompt);
    // Phase 8A: the reject-reason prompt is free text → composing-mode Reply
    // Keyboard; the skip is a text button now (legacy adm:skip: taps still work).
    const kb = prompt.payload['reply_markup'] as {
      keyboard: { text: string }[][];
    };
    assert.ok(
      kb.keyboard.flat().some((b) => b.text === '❌ ثبت رد بدون دلیل'),
    );
    assert.ok(
      kb.keyboard.flat().some((b) => b.text === '🔙 بازگشت به منو'),
    );

    stub.reset();
    await dispatch(messageUpdateAs(ADMIN, 'مبلغ واریزی با فیش نمی‌خواند', nextId()));

    const order = orderById(orderId);
    assert.equal(order?.state, 'rejected');
    assert.equal(order?.failure_reason, 'مبلغ واریزی با فیش نمی‌خواند');
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()['n'],
      0,
    );
    assert.ok(eventsOf(orderId).some((e) => e.action === 'payment_rejected'));

    const notice = sentTo(USER.id).find((s) => String(s.text).includes('تأیید نشد'));
    assert.ok(notice && String(notice.text).includes('مبلغ واریزی با فیش نمی‌خواند'));
    assert.equal(sessionFor(USER.id).state, 'IDLE');
    assert.ok(
      sentTo(ADMIN.id).some((s) => s.method === 'sendMessage' && String(s.text).includes('رد شد')),
    );
  } finally {
    clearAdminEnv();
  }
});

test('reject via skip button uses the default reason', async () => {
  const orderId = await purchase();
  await dispatch(
    mediaUpdate(nextId(), { kind: 'document', fileId: 'REJECT_DOC', caption: 'ref-9' }),
  );
  assert.equal(orderById(orderId)?.state, 'awaiting_review');
  assert.equal(orderById(orderId)?.payment_reference, 'ref-9'); // document route

  prevAdminEnv();
  try {
    await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
    stub.reset();
    await dispatch(callbackUpdateAs(`adm:skip:${orderId}`, nextId(), ADMIN, ADMIN.id));

    assert.equal(orderById(orderId)?.state, 'rejected');
    assert.equal(orderById(orderId)?.failure_reason, 'پرداخت تأیید نشد.');
    assert.ok(sentTo(USER.id).some((s) => String(s.text).includes('تأیید نشد')));
  } finally {
    clearAdminEnv();
  }
});

test('skip without an active pending reject does nothing', async () => {
  const orderId = await purchase();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'SKIP_ORPHAN' }));
  prevAdminEnv();
  try {
    stub.reset();
    await dispatch(callbackUpdateAs(`adm:skip:${orderId}`, nextId(), ADMIN, ADMIN.id));
    assert.equal(orderById(orderId)?.state, 'awaiting_review'); // untouched
    assert.equal(callsFor('editMessageCaption').length, 0);
    assert.equal(sentTo(USER.id).length, 0);
  } finally {
    clearAdminEnv();
  }
});

test('cancel button clears the pending reject before a reason is sent', async () => {
  const orderId = await purchase();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'CANCEL_ME' }));
  prevAdminEnv();
  try {
    await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
    stub.reset();
    await dispatch(callbackUpdateAs('act:back_menu', nextId(), ADMIN, ADMIN.id));
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM admin_actions WHERE admin_user_id = ?1').get(
        String(ADMIN.id),
      )['n'],
      0,
    );
    assert.ok(stub.sent.some((s) => String(s.payload['text'] ?? '').includes('لغو شد')));
    // order fully intact for a later review
    assert.equal(orderById(orderId)?.state, 'awaiting_review');
  } finally {
    clearAdminEnv();
  }
});

test('text/notice behavior while waiting for receipt stays safe', async () => {
  const orderId = await purchase();
  stub.reset();
  await dispatch(messageUpdateAs(USER, 'فیش رو فرستادم، کجاست؟', nextId()));
  const waited = sends().find((s) => String(s.text).includes('انتظار بررسی'));
  assert.ok(waited);
  assert.equal(orderById(orderId)?.receipt_file_id, null); // text is not a receipt

  // media uploaded during an unfinished purchase: guidance, no order writes
  const newOrderIdBefore = sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get()['n'];
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'mid flow alpha', nextId())); // WAITING_VOLUME now
  stub.reset();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'WRONG_TIME' }));
  assert.ok(sends().some((s) => String(s.text).includes('تصویر یا فایل')));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get()['n'], newOrderIdBefore);
});

test('menu:orders lists the customer’s recent orders with statuses', async () => {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:orders', nextId(), USER));
  const listed = sends().find((s) => String(s.text).includes('سفارش‌های شما'));
  assert.ok(listed);
  assert.ok(String(listed.text).includes('❌')); // rejected order shown with status
  assert.ok(String(listed.text).includes('تومان'));
});

test('is_admin DB flag authorizes without env; admin rows reach forwarding', async () => {
  // promote USER’s counterpart: a fresh DB-registered admin (no env)
  const DBADMIN = { id: 222222222, first_name: 'Negar', username: 'negar_admin', language_code: 'fa' };
  await dispatch(messageUpdateAs(DBADMIN, '/start', nextId()));
  sqlite.prepare('UPDATE customers SET is_admin = 1 WHERE telegram_user_id = ?1').run(String(DBADMIN.id));

  const orderId = await purchase();
  stub.reset();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'DBFORWARD' }));
  const forwarded = callsFor('sendPhoto').find(
    (s) => Number(s.payload['chat_id']) === DBADMIN.id,
  );
  assert.ok(forwarded, 'forwarded to DB admin');

  stub.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), DBADMIN, DBADMIN.id));
  assert.equal(orderById(orderId)?.state, 'approved');
  assert.equal(orderById(orderId)?.verified_by, String(DBADMIN.id));
});

test('receipt for a session without an order resets politely', async () => {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO conversation_states (customer_id, state, data)
       VALUES ((SELECT id FROM customers WHERE telegram_user_id = ?1),
               'WAITING_PAYMENT_RECEIPT', '{"config_name":"x"}')`,
    )
    .run(String(USER.id));
  stub.reset();
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'ORPHAN_RECEIPT' }));
  assert.ok(sends().some((s) => String(s.text).includes('پیدا نشد')));
  assert.equal(sessionFor(USER.id).state, 'IDLE'); // cleared
});

test('order id sanity: newOrderId shape matches the admin callback regex', () => {
  const id = newOrderId();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{28}$/);
});
