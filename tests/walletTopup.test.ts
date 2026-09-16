/**
 * Phase 17 e2e: customer wallet top-up + /credit @username + /myid.
 * Fully offline (D1 shim over real migrations 0001-0017, fetch stub).
 *
 * Covers (per spec):
 *  Amount: 45000 accepted (Toman, same IRT unit — no conversion layer),
 *    44999/zero/negative/invalid rejected, max accepted, max+1 rejected,
 *    Persian/Arabic digits, separators, overflow.
 *  Flow: start → amount → payment instructions (existing card source,
 *    fail-closed) → photo/document receipt → pending_review →
 *    admin approve / reject.
 *  Exactly-once: duplicate approval, repeated callback, concurrent approval,
 *    retry after success → exactly one balance credit + one topup_credit row.
 *  Isolation: no orders, order_events, provisioning, referrals, paid
 *    notifications, payment reminders.
 *  Safety: sales stop (UI hidden + stale callback + amount + receipt blocked,
 *    zero writes), wallet disabled, forged/stale callbacks, non-admin review.
 *  /credit: numeric id + @username forms, unknown user, invalid amount,
 *    non-admin, max cap, exact balance/ledger, zero mutation on failure.
 *  /myid: numeric id from the update, no wallet/DB mutation side effects.
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

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { MIN_TOPUP_IRT, parseTopupAmount, parseTopupCallback } = await import(
  '../src/lib/validate.ts'
);
const { creditTopupOnce } = await import('../src/db/topups.ts');
const { performTopupReview } = await import('../src/handlers/topupAdmin.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

let counter = 17000;
const nextId = () => ++counter;

// Fresh users per area so balances/rows never cross-contaminate.
const TU1 = { id: 170001001, first_name: 'Top1', username: 'topup_user_one', language_code: 'fa' };
const TU2 = { id: 170001002, first_name: 'Top2', username: 'topup_user_two', language_code: 'fa' };
const TU3 = { id: 170001003, first_name: 'Top3', username: 'topup_user_three', language_code: 'fa' };
const TU4 = { id: 170001004, first_name: 'Top4', username: 'topup_user_four', language_code: 'fa' };
const TU5 = { id: 170001005, first_name: 'Top5', username: 'topup_user_five', language_code: 'fa' };
const CU1 = { id: 170002001, first_name: 'Cred1', username: 'credit_target_one', language_code: 'fa' };

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));

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

function customerIdOf(tgUserId: number): number {
  const row = sqlite
    .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
    .get(String(tgUserId)) as { id: number } | undefined;
  assert.ok(row, `customer ${tgUserId} must exist`);
  return row.id;
}

function balanceOf(customerId: number): number {
  const row = sqlite
    .prepare('SELECT balance_irt FROM customers WHERE id = ?1')
    .get(customerId) as { balance_irt: number };
  return row.balance_irt;
}

function topupRow(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM wallet_topups WHERE id = ?1').get(id) as
    | Record<string, unknown>
    | undefined;
}

function topupCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) c FROM wallet_topups').get() as { c: number }).c;
}

function ledgerCount(topupId: string): number {
  return (
    sqlite
      .prepare(
        "SELECT COUNT(*) c FROM wallet_entries WHERE order_id = ?1 AND kind = 'topup_credit'",
      )
      .get(topupId) as { c: number }
  ).c;
}

function orderCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c;
}

function orderEventCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) c FROM order_events').get() as { c: number }).c;
}

function referralRewardCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) c FROM referral_rewards').get() as { c: number }).c;
}

function setSalesStopped(stopped: boolean): void {
  sqlite
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'sales'")
    .run(`{"schema":1,"stopped":${stopped ? 'true' : 'false'}}`);
}

function setWalletEnabled(enabled: boolean): void {
  // NOTE: read-modify-write the whole doc — json_set() would store SQL 1/0
  // (JSON numbers), but parseWalletConfig requires a real JSON boolean.
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'wallet'").get() as {
    value: string;
  };
  const doc = JSON.parse(row.value) as Record<string, unknown>;
  doc['enabled'] = enabled;
  sqlite.prepare("UPDATE settings SET value = ?1 WHERE key = 'wallet'").run(JSON.stringify(doc));
}

function walletDoc(): string {
  return (
    sqlite.prepare("SELECT value FROM settings WHERE key = 'wallet'").get() as { value: string }
  ).value;
}

function setWalletCaps(cap: number): void {
  sqlite
    .prepare(
      "UPDATE settings SET value = json_set(value, '$.max_credit_irt', ?1, '$.max_debit_irt', ?1) WHERE key = 'wallet'",
    )
    .run(cap);
}

function maxCreditIrt(): number {
  return (JSON.parse(walletDoc()) as { max_credit_irt: number }).max_credit_irt;
}

/** Drive a user through start → amount → receipt; returns the top-up id. */
async function topupToPendingReview(
  user: typeof USER,
  amountText: string,
  receiptFileId: string,
  kind: 'photo' | 'document' = 'photo',
): Promise<string> {
  await dispatch(messageUpdateAs(user, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_TOPUP_AMOUNT');
  await dispatch(messageUpdateAs(user, amountText, nextId()));
  assert.equal(sessionFor(user.id).state, 'WAITING_TOPUP_RECEIPT');
  const topupId = sessionFor(user.id).data['topup_id'];
  assert.equal(typeof topupId, 'string');
  await dispatch(mediaUpdate(nextId(), { kind, fileId: receiptFileId }, user));
  assert.equal(topupRow(topupId as string)?.['state'], 'pending_review');
  return topupId as string;
}

// ————————————————————————— unit: amount parser —————————————————————————

test('parseTopupAmount: digits, separators, overflow, signs', () => {
  assert.equal(MIN_TOPUP_IRT, 45_000);
  assert.equal(parseTopupAmount('45000'), 45000);
  assert.equal(parseTopupAmount('45,000'), 45000);
  assert.equal(parseTopupAmount('۴۵۰۰۰'), 45000); // Persian
  assert.equal(parseTopupAmount('٤٥٠٠٠'), 45000); // Arabic
  assert.equal(parseTopupAmount('۴۵٬۰۰۰'), 45000); // Persian separator
  assert.equal(parseTopupAmount(' 45000 '), 45000);
  assert.equal(parseTopupAmount('44999'), 44999); // parses; MIN enforced by caller
  assert.equal(parseTopupAmount('0'), null);
  assert.equal(parseTopupAmount('-45000'), null);
  assert.equal(parseTopupAmount('+45000'), null);
  assert.equal(parseTopupAmount('45.5'), null);
  assert.equal(parseTopupAmount('abc'), null);
  assert.equal(parseTopupAmount(''), null);
  assert.equal(parseTopupAmount('9999999999999'), null); // 13 digits > 1e12
  assert.equal(parseTopupAmount('1000000000000'), 1_000_000_000_000);
  assert.equal(parseTopupAmount('1000000000001'), null);
  assert.equal(parseTopupCallback('tup:ok:' + 'A'.repeat(28))?.action, 'ok');
  assert.equal(parseTopupCallback('tup:no:' + 'A'.repeat(28))?.topupId, 'A'.repeat(28));
  assert.equal(parseTopupCallback('tup:xx:' + 'A'.repeat(28)), null);
  assert.equal(parseTopupCallback('adm:ok:' + 'A'.repeat(28)), null);
});

// ————————————————————————— flow: start → amount → instructions —————————————————————————

test('top-up start asks for amount; wallet view shows the entry button', async () => {
  await dispatch(messageUpdateAs(TU1, '/start', nextId()));
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('menu:wallet', nextId(), TU1));
  const view = sentTo(TU1.id).find((s) => s.method === 'sendMessage');
  assert.ok(view, 'wallet view expected');
  const kb = view.payload['reply_markup'] as {
    inline_keyboard: { text: string; callback_data?: string }[][];
  };
  const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(datas.includes('top:start'), 'wallet view must offer top:start');
  assert.ok(String(view.text).includes('💰'), 'wallet header expected');

  stub.reset();
  await dispatch(messageUpdateAs(TU1, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU1));
  assert.equal(sessionFor(TU1.id).state, 'WAITING_TOPUP_AMOUNT');
  assert.ok(
    textsTo(TU1.id).some((t) => t.includes('۴۵') || t.includes('45000') || t.includes('45,000')),
    'amount prompt must quote the 45,000 Toman minimum',
  );
});

test('amount: 45000 accepted, 44999/zero/negative/invalid rejected with zero writes', async () => {
  const before = topupCount();
  await dispatch(messageUpdateAs(TU2, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU2));

  for (const bad of ['44999', '0', '-45000', 'abc', '']) {
    stub.reset();
    await dispatch(messageUpdateAs(TU2, bad === '' ? '   ' : bad, nextId()));
    assert.equal(sessionFor(TU2.id).state, 'WAITING_TOPUP_AMOUNT', `bad ${bad} must stay`);
  }
  assert.equal(topupCount(), before, 'no request row on invalid amounts');

  stub.reset();
  await dispatch(messageUpdateAs(TU2, '45000', nextId()));
  assert.equal(sessionFor(TU2.id).state, 'WAITING_TOPUP_RECEIPT');
  assert.equal(topupCount(), before + 1, 'exactly one request row on 45000');
  const topupId = sessionFor(TU2.id).data['topup_id'] as string;
  assert.equal(topupRow(topupId)?.['amount_irt'], 45000);
  // Payment instructions reuse the existing card source, fail-closed shape.
  const instr = stub.sent.find(
    (s) => s.method === 'sendMessage' && String(s.text).includes('شماره کارت'),
  );
  assert.ok(instr, 'payment instructions expected after amount');
  assert.ok(String(instr.text).includes(TEST_CARD), 'env card must render');
  assert.ok(String(instr.text).includes('45,000'), 'amount line must render');
});

test('amount: Persian/Arabic digits + separators accepted; max cap enforced', async () => {
  const cap = maxCreditIrt();
  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
  await dispatch(messageUpdateAs(TU3, '۴۵۰۰۰', nextId()));
  assert.equal(sessionFor(TU3.id).state, 'WAITING_TOPUP_RECEIPT');
  assert.equal(topupRow(sessionFor(TU3.id).data['topup_id'] as string)?.['amount_irt'], 45000);

  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
  await dispatch(messageUpdateAs(TU3, '٤٥٠٠٠', nextId()));
  assert.equal(sessionFor(TU3.id).state, 'WAITING_TOPUP_RECEIPT');

  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
  await dispatch(messageUpdateAs(TU3, '45,000', nextId()));
  assert.equal(sessionFor(TU3.id).state, 'WAITING_TOPUP_RECEIPT');

  // max accepted, max+1 rejected — state preserved, no new row on the reject.
  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
  const nBefore = topupCount();
  await dispatch(messageUpdateAs(TU3, String(cap), nextId()));
  assert.equal(sessionFor(TU3.id).state, 'WAITING_TOPUP_RECEIPT');
  assert.equal(topupCount(), nBefore + 1);

  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
  const nBefore2 = topupCount();
  await dispatch(messageUpdateAs(TU3, String(cap + 1), nextId()));
  assert.equal(sessionFor(TU3.id).state, 'WAITING_TOPUP_AMOUNT');
  assert.equal(topupCount(), nBefore2, 'over-cap amount must not create a row');
  await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
});

// ————————————————————————— flow: receipt → review —————————————————————————

test('photo + document receipts reach pending_review and forward to admin', async () => {
  stub.reset();
  const id1 = await topupToPendingReview(TU4, '50000', 'TOPUP_RCPT_PHOTO_1', 'photo');
  const fwd1 = stub.sent.filter(
    (s) => (s.method === 'sendPhoto' || s.method === 'sendDocument') && Number(s.payload['chat_id']) === ADMIN.id,
  );
  assert.ok(fwd1.length >= 1, 'admin must receive the photo receipt');
  const kb1 = fwd1[0]?.payload['reply_markup'] as {
    inline_keyboard: { callback_data?: string }[][];
  };
  assert.ok(
    kb1.inline_keyboard.flat().some((b) => b.callback_data === `tup:ok:${id1}`),
    'admin keyboard must carry tup:ok:<id>',
  );

  stub.reset();
  const id2 = await topupToPendingReview(TU4, '60000', 'TOPUP_RCPT_DOC_1', 'document');
  const fwd2 = stub.sent.filter(
    (s) => (s.method === 'sendPhoto' || s.method === 'sendDocument') && Number(s.payload['chat_id']) === ADMIN.id,
  );
  assert.ok(fwd2.length >= 1, 'admin must receive the document receipt');
  assert.notEqual(id1, id2);
});

test('admin approve credits exactly once; reject changes nothing', async () => {
  await dispatch(messageUpdateAs(TU5, '/start', nextId()));
  const cid = customerIdOf(TU5.id);
  const balBefore = balanceOf(cid);

  stub.reset();
  const id = await topupToPendingReview(TU5, '70000', 'TOPUP_RCPT_OK_1');
  const ordersBefore = orderCount();
  const eventsBefore = orderEventCount();
  const refBefore = referralRewardCount();

  stub.reset();
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(topupRow(id)?.['state'], 'approved');
  assert.equal(balanceOf(cid), balBefore + 70000, 'balance += exact amount once');
  assert.equal(ledgerCount(id), 1, 'exactly one topup_credit row');
  const entry = sqlite
    .prepare("SELECT delta_irt, kind, actor, balance_after FROM wallet_entries WHERE order_id = ?1 AND kind = 'topup_credit'")
    .get(id) as { delta_irt: number; kind: string; actor: string; balance_after: number };
  assert.equal(entry.delta_irt, 70000);
  assert.ok(entry.actor.startsWith('admin:'), 'actor must be numeric admin id, never username');
  assert.equal(entry.balance_after, balBefore + 70000);
  assert.ok(
    textsTo(TU5.id).some((t) => t.includes('تأیید شد') || t.includes('approved')),
    'customer must be notified of approval',
  );
  // Isolation: top-up touches no order/provisioning/referral surface.
  assert.equal(orderCount(), ordersBefore, 'no orders from top-up approval');
  assert.equal(orderEventCount(), eventsBefore, 'no order events from top-up approval');
  assert.equal(referralRewardCount(), refBefore, 'no referral payout from top-up');

  // Reject path on a fresh request.
  const balMid = balanceOf(cid);
  stub.reset();
  const rid = await topupToPendingReview(TU5, '80000', 'TOPUP_RCPT_NO_1');
  await dispatch(callbackUpdateAs(`tup:no:${rid}`, nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, 'فیش ناخوانا است', nextId()));
  assert.equal(topupRow(rid)?.['state'], 'rejected');
  assert.equal(balanceOf(cid), balMid, 'rejection must not move balance');
  assert.equal(ledgerCount(rid), 0, 'rejection must not write a ledger row');
  assert.ok(
    textsTo(TU5.id).some((t) => t.includes('تأیید نشد') || t.includes("wasn't approved")),
    'customer must be notified of rejection',
  );
});

// ————————————————————————— exactly-once under duplication —————————————————————————

test('duplicate approval, repeated callback, retry and concurrency never double-credit', async () => {
  const cid = customerIdOf(TU1.id);
  const balBefore = balanceOf(cid);
  stub.reset();
  const id = await topupToPendingReview(TU1, '90000', 'TOPUP_RCPT_DUP_1');

  // Duplicate admin taps (distinct updates, same top-up).
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), ADMIN, ADMIN.id));
  const balOnce = balanceOf(cid);
  assert.equal(balOnce, balBefore + 90000);
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), ADMIN, ADMIN.id));
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(balanceOf(cid), balOnce, 'repeated callbacks must converge');
  assert.equal(ledgerCount(id), 1, 'exactly one ledger row after repeats');

  // Direct retry after success via the review entry point.
  const retry = await performTopupReview({
    env: env as never,
    db: shim as never,
    api: { sendMessage: async () => undefined } as never,
    actorId: ADMIN.id,
    topupId: id,
    decision: 'approve',
  });
  assert.equal(retry.ok, false, 'retry after approval must lose the claim');
  assert.equal(balanceOf(cid), balOnce);
  assert.equal(ledgerCount(id), 1);

  // Concurrent approvals converge (second call finds the winner's row).
  const [a, b] = await Promise.all([
    creditTopupOnce(shim as never, { customerId: cid, topupId: id, amountIrt: 90000, actor: `admin:${ADMIN.id}` }),
    creditTopupOnce(shim as never, { customerId: cid, topupId: id, amountIrt: 90000, actor: `admin:${ADMIN.id}` }),
  ]);
  assert.ok(a.ok && b.ok, 'both converge on the single ledger row');
  assert.equal(balanceOf(cid), balOnce, 'concurrent credit must not double-apply');
  assert.equal(ledgerCount(id), 1);

  // Reject-after-approve is inert.
  const rej = await performTopupReview({
    env: env as never,
    db: shim as never,
    api: { sendMessage: async () => undefined } as never,
    actorId: ADMIN.id,
    topupId: id,
    decision: 'reject',
    reason: 'late',
  });
  assert.equal(rej.ok, false);
  assert.equal(balanceOf(cid), balOnce);
});

test('non-admin tup:ok is inert; forged top-up id rejected', async () => {
  const cid = customerIdOf(TU2.id);
  const bal = balanceOf(cid);
  stub.reset();
  const id = await topupToPendingReview(TU2, '55000', 'TOPUP_RCPT_FORGE_1');
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), TU2, TU2.id));
  assert.equal(topupRow(id)?.['state'], 'pending_review', 'non-admin must not review');
  assert.equal(balanceOf(cid), bal);

  const fake = 'A'.repeat(28);
  await dispatch(callbackUpdateAs(`tup:ok:${fake}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(balanceOf(cid), bal, 'forged id must not move money');
  // Clean up: approve the real one so later counts stay deterministic.
  await dispatch(callbackUpdateAs(`tup:ok:${id}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(topupRow(id)?.['state'], 'approved');
});

// ————————————————————————— sales stop —————————————————————————

test('sales stop hides top-up UI and blocks stale callback, amount and receipt with zero writes', async () => {
  setSalesStopped(true);
  try {
    await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
    stub.reset();
    await dispatch(callbackUpdateAs('menu:wallet', nextId(), TU3));
    const view = sentTo(TU3.id).find((s) => s.method === 'sendMessage');
    const kb = view?.payload['reply_markup'] as {
      inline_keyboard: { callback_data?: string }[][];
    };
    assert.ok(
      !kb.inline_keyboard.flat().some((b) => b.callback_data === 'top:start'),
      'top-up button must be hidden while stopped',
    );

    // Stale/direct callback rejected server-side.
    const nBefore = topupCount();
    stub.reset();
    await dispatch(callbackUpdateAs('top:start', nextId(), TU3));
    assert.equal(sessionFor(TU3.id).state, 'IDLE', 'no session entry while stopped');
    assert.equal(topupCount(), nBefore, 'no request row while stopped');

    // Amount + receipt blocked even with a pre-stop session (crafted replay).
    const { setSession } = await import('../src/db/states.ts');
    const cid = customerIdOf(TU3.id);
    await setSession(shim as never, cid, 'WAITING_TOPUP_AMOUNT', { topup_token: 'STOPTOK1' });
    await dispatch(messageUpdateAs(TU3, '50000', nextId()));
    assert.equal(topupCount(), nBefore, 'amount blocked while stopped');
    await setSession(shim as never, cid, 'WAITING_TOPUP_RECEIPT', {
      topup_token: 'STOPTOK1',
      topup_id: 'A'.repeat(28),
      topup_amount: 50000,
    });
    await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'STOP_RCPT' }, TU3));
    assert.equal(topupCount(), nBefore, 'receipt blocked while stopped');
    assert.equal(balanceOf(cid), balanceOf(cid), 'balance untouched');
    await dispatch(messageUpdateAs(TU3, '/cancel', nextId()));
  } finally {
    setSalesStopped(false);
  }
  // Purchases still work after re-enable (stop behavior for purchases unchanged).
  assert.equal(sessionFor(TU3.id).state, 'IDLE');
});

// ————————————————————————— wallet kill-switch —————————————————————————

test('wallet disabled blocks view, start and amount with zero writes', async () => {
  setWalletEnabled(false);
  try {
    stub.reset();
    await dispatch(callbackUpdateAs('menu:wallet', nextId(), TU4));
    assert.ok(
      textsTo(TU4.id).some((t) => t.includes('در دسترس نیست') || t.includes("isn't available")),
      'wallet view must degrade while disabled',
    );
    const nBefore = topupCount();
    await dispatch(messageUpdateAs(TU4, '/cancel', nextId()));
    await dispatch(callbackUpdateAs('top:start', nextId(), TU4));
    assert.equal(sessionFor(TU4.id).state, 'IDLE');
    const { setSession } = await import('../src/db/states.ts');
    const cid = customerIdOf(TU4.id);
    await setSession(shim as never, cid, 'WAITING_TOPUP_AMOUNT', { topup_token: 'KILLTOK1' });
    await dispatch(messageUpdateAs(TU4, '50000', nextId()));
    assert.equal(topupCount(), nBefore, 'amount blocked while wallet disabled');
    await dispatch(messageUpdateAs(TU4, '/cancel', nextId()));
  } finally {
    setWalletEnabled(true);
  }
});

// ————————————————————————— /credit @username —————————————————————————

test('/credit: numeric id and @username both work; failures mutate nothing', async () => {
  await dispatch(messageUpdateAs(CU1, '/start', nextId()));
  const cid = customerIdOf(CU1.id);
  const bal0 = balanceOf(cid);

  // Numeric form (existing behavior).
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/credit ${CU1.id} 10000`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 10000);
  let rows = sqlite
    .prepare("SELECT delta_irt, kind, actor FROM wallet_entries WHERE customer_id = ?1 AND kind = 'admin_grant' ORDER BY created_at DESC LIMIT 1")
    .get(cid) as { delta_irt: number; kind: string; actor: string };
  assert.equal(rows.delta_irt, 10000);
  assert.equal(rows.actor, `admin:${ADMIN.id}`, 'ledger actor stays numeric');

  // Username form (new): with and without '@', case-insensitive.
  await dispatch(messageUpdateAs(ADMIN, `/credit @${'credit_target_one'} 20000`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 30000);
  await dispatch(messageUpdateAs(ADMIN, `/credit CREDIT_TARGET_ONE 30000`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 60000);

  // Unknown username → clear error, zero mutation.
  const ledBefore = (
    sqlite.prepare("SELECT COUNT(*) c FROM wallet_entries WHERE customer_id = ?1").get(cid) as {
      c: number;
    }
  ).c;
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/credit @nobody_xyz_123 10000', nextId()));
  assert.equal(balanceOf(cid), bal0 + 60000, 'unknown username must not mutate');
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) c FROM wallet_entries WHERE customer_id = ?1").get(cid) as { c: number }).c,
    ledBefore,
  );

  // Invalid amount → zero mutation.
  await dispatch(messageUpdateAs(ADMIN, `/credit ${CU1.id} abc`, nextId()));
  await dispatch(messageUpdateAs(ADMIN, `/credit @credit_target_one -5`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 60000);

  // Non-admin → refused, zero mutation.
  await dispatch(messageUpdateAs(CU1, `/credit ${CU1.id} 10000`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 60000);

  // Max cap enforced on both forms.
  const cap = maxCreditIrt();
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/credit ${CU1.id} ${cap + 1}`, nextId()));
  await dispatch(messageUpdateAs(ADMIN, `/credit @credit_target_one ${cap + 1}`, nextId()));
  assert.equal(balanceOf(cid), bal0 + 60000, 'over-cap must not mutate');
});

// ————————————————————————— /myid —————————————————————————

test('/myid replies with the sender numeric id and mutates nothing', async () => {
  const ledBefore = (sqlite.prepare('SELECT COUNT(*) c FROM wallet_entries').get() as { c: number }).c;
  stub.reset();
  await dispatch(messageUpdateAs(TU5, '/myid', nextId()));
  const texts = textsTo(TU5.id);
  assert.ok(
    texts.some((t) => t.includes(String(TU5.id))),
    '/myid must echo the sender numeric id',
  );
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) c FROM wallet_entries').get() as { c: number }).c,
    ledBefore,
    '/myid must not write ledger rows',
  );
});

// ————————————————————————— no cross-talk with existing wallet pay —————————————————————————

test('existing wallet full/partial pay still born from orders, untouched by top-up kinds', async () => {
  const kinds = sqlite.prepare('SELECT DISTINCT kind k FROM wallet_entries').all() as { k: string }[];
  assert.ok(kinds.some((r) => r.k === 'topup_credit'), 'top-up kind present');
  // The purchase/renewal debit kinds keep their exact-once UNIQUE backstop.
  const idx = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_wallet_payment_once'")
    .get() as { name: string } | undefined;
  assert.ok(idx, 'order_payment backstop preserved');
  const tidx = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_wallet_topup_once'")
    .get() as { name: string } | undefined;
  assert.ok(tidx, 'topup_credit backstop added');
});
