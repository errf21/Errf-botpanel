/**
 * Phase 7 e2e: wallet + referrals + support tickets + announcements — fully
 * offline (D1 shim over real migrations 0001-0007, fetch stub; the panel is
 * deliberately NOT configured, so every provisioning touch must be the
 * fail-closed no-op from P5, and every approval stays a plain DB write).
 * Covers: guarded gr/debit + caps, full-pay born-approved orders (no receipt,
 * no queue), partial credit through the SHARED review pipeline + reject
 * refund, exactly-once replay guards on the debit key, first-touch referral
 * attribution + single capped PERCENT-of-purchase payout, ticket lifecycle
 * with forgery gates, and confirm + idempotent broadcast fan-out with
 * delivery dedupe. Hardening: atomic single-apply payment claim, refund on
 * wallet-full checkout hard-fail (purchase + renewal), floor/zero-skip
 * percent math, referral config bounds.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  TEST_CARD,
  USER,
  callbackUpdate,
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
const { payOrderWithWallet, applyWalletMutation } = await import('../src/db/wallet.ts');
const { payReferrerIfDue, referralRewardIrt } = await import('../src/lib/referralPayout.ts');
const { parseReferralConfig } = await import('../src/catalog/referral.ts');
const { ensureReferralCode, isReferralCode, newReferralCode } = await import('../src/db/referrals.ts');
const { newOrderId } = await import('../src/lib/security.ts');

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

let counter = 7000;
const nextId = () => ++counter;

const USER2 = { id: 222333444, first_name: 'Reza', username: 'reza_two', language_code: 'fa' };
const NEWBIE = { id: 999000111, first_name: 'Sara', username: 'sara_new', language_code: 'fa' };
const NEWBIE2 = { id: 999000112, first_name: 'Omid', username: 'omid_new', language_code: 'fa' };

const sends = () => stub.sendCalls();
const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));

interface OrderRowLite {
  id: string;
  customer_id: number;
  state: string;
  amount: number;
  verified_by: string | null;
  selections: string;
  kind: string;
}

function orderById(id: string): OrderRowLite | undefined {
  return sqlite.prepare('SELECT * FROM orders WHERE id = ?1').get(id) as
    | OrderRowLite
    | undefined;
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

/** Dispatch menu:invite with a temporary getMe-aware fetch stub. */
async function inviteWithGetMe(user: typeof USER): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.match(/\/bot[^/]+\/(\w+)$/)?.[1] ?? 'unknown';
    const payload = (JSON.parse(String(init?.body ?? '{}')) ?? {}) as Record<string, unknown>;
    stub.sent.push({ method, text: payload['text'], payload: { chat_id: payload['chat_id'], ...payload } });
    if (method === 'getMe') {
      return Response.json({ ok: true, result: { id: 1, is_bot: true, username: 'telbotv2_test' } });
    }
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
  try {
    await dispatch(callbackUpdateAs('menu:invite', nextId(), user));
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Full purchase ladder up to (not including) the confirm tap; price 95000
 *  (base product 45000 + 0 extra GB + the 3-user entry 50000 — exact table
 *  values, no multipliers). */
async function purchaseToSummary(user: typeof USER): Promise<string> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  await dispatch(messageUpdateAs(user, `northvalley7`, nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), user)); // base volume: +0
  await dispatch(callbackUpdateAs('dur:30', nextId(), user)); // 1 month = base 45000
  await dispatch(callbackUpdateAs('dev:3', nextId(), user)); // users entry: 50000
  assert.equal(sessionFor(user.id).state, 'WAITING_ORDER_CONFIRMATION');
  const token = sessionFor(user.id).data['order_token'];
  assert.equal(typeof token, 'string');
  return token as string;
}

/** Purchase → receipt → admin approve (the untouched P4 pipeline). */
async function purchaseAndApprove(user: typeof USER, receiptFileId: string): Promise<string> {
  await purchaseToSummary(user);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  const orderId = sessionFor(user.id).data['order_id'] as string;
  assert.ok(orderId);
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: receiptFileId }, user));
  assert.equal(orderById(orderId)?.state, 'awaiting_review');
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(orderById(orderId)?.state, 'approved');
  return orderId;
}

function setWalletCreditCap(cap: number): void {
  sqlite
    .prepare("UPDATE settings SET value = json_set(value, '$.max_credit_irt', ?1, '$.max_debit_irt', ?1) WHERE key = 'wallet'")
    .run(cap);
}

// ————————————————————————— registry + menu —————————————————————————

test('main menu grew wallet + invite rows (P7)', async () => {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  await dispatch(messageUpdateAs(USER2, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  const menu = sentTo(USER.id).find((s) => s.method === 'sendMessage');
  // Phase 8A: the main menu is a Reply Keyboard — buttons carry text, not data.
  const kb = menu?.payload['reply_markup'] as { keyboard: { text: string }[][] };
  const labels = kb.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('💰 کیف پول'));
  assert.ok(labels.includes('🤝 دعوت از دوستان'));
  assert.ok(labels.includes('🆘 پشتیبانی'));
});

// ————————————————————————— wallet admin ops —————————————————————————

test('/credit arms, amount applies, over-cap + insufficient decline (guarded writes)', async () => {
  setWalletCreditCap(10_000_000);
  const target = customerIdOf(USER.id);
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/credit ${USER.id}`, nextId()));
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('مبلغ')));
  assert.ok(
    sqlite
      .prepare("SELECT * FROM admin_actions WHERE admin_user_id = ?1 AND action = 'wallet_grant'")
      .get(String(ADMIN.id)),
    'grant armed',
  );

  // garbage amount: re-prompt, still armed, zero effect
  await dispatch(messageUpdateAs(ADMIN, 'abc', nextId()));
  assert.equal(balanceOf(target), 0);
  assert.ok(
    sqlite
      .prepare("SELECT * FROM admin_actions WHERE admin_user_id = ?1 AND action = 'wallet_grant'")
      .get(String(ADMIN.id)),
    'still armed after garbage',
  );

  await dispatch(messageUpdateAs(ADMIN, '۵۰۰۰۰۰', nextId())); // Persian digits
  assert.equal(balanceOf(target), 500000);
  const [entry] = sqlite
    .prepare('SELECT * FROM wallet_entries WHERE customer_id = ?1 ORDER BY id')
    .all(target) as Array<Record<string, unknown>>;
  assert.equal(entry?.kind, 'admin_grant');
  assert.equal(entry?.delta_irt, 500000);
  assert.equal(entry?.actor, `admin:${ADMIN.id}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM admin_actions').get()['n'], 0);

  // over-cap declines
  await dispatch(messageUpdateAs(ADMIN, `/credit ${USER.id} 99999999999`, nextId()));
  assert.equal(balanceOf(target), 500000);

  // inline debit works; over-balance declines
  await dispatch(messageUpdateAs(ADMIN, `/debit ${USER.id} 200000`, nextId()));
  assert.equal(balanceOf(target), 300000);
  await dispatch(messageUpdateAs(ADMIN, `/debit ${USER.id} 400000`, nextId()));
  assert.equal(balanceOf(target), 300000);
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('کافی نیست')), `t=${textsTo(ADMIN.id).join('|')}`);
});

test('wallet commands are admin-gated', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(USER, `/credit ${USER2.id} 100000`, nextId()));
  assert.equal(balanceOf(customerIdOf(USER2.id)), 0);
  assert.ok(textsTo(USER.id).some((t) => t.includes('دسترس')), `texts=${JSON.stringify(textsTo(USER.id))}`);
});

test('menu:wallet renders balance + ledger', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs('menu:wallet', nextId(), USER));
  const texts = textsTo(USER.id);
  assert.ok(texts.some((t) => t.includes('کیف پول شما')));
  assert.ok(texts.some((t) => t.includes('موجودی')));
});

test('P7 wallet additions leave P3 summary behavior intact (no balance → plain confirm)', async () => {
  const target = customerIdOf(USER.id);
  const balBefore = balanceOf(target);
  sqlite.prepare('UPDATE customers SET balance_irt = 0 WHERE id = ?1').run(target);
  await purchaseToSummary(USER);
  if (balBefore > 0) sqlite.prepare('UPDATE customers SET balance_irt = ?1 WHERE id = ?2').run(balBefore, target);
  else sqlite.prepare('UPDATE customers SET balance_irt = 0 WHERE id = ?1').run(target);
});

test('wallet kill switch hides pay buttons and blocks the view', async () => {
  const doc = sqlite.prepare("SELECT value FROM settings WHERE key = 'wallet'").get()['value'] as string;
  sqlite.prepare("UPDATE settings SET value = json_set(value, '$.enabled', false) WHERE key = 'wallet'").run();
  try {
    const target = customerIdOf(USER.id);
    sqlite.prepare('UPDATE customers SET balance_irt = 400000 WHERE id = ?1').run(target);
    stub.reset();
    await dispatch(callbackUpdateAs('menu:wallet', nextId(), USER));
    assert.ok(textsTo(USER.id).some((t) => t.includes('در دسترس نیست')));
    await purchaseToSummary(USER);
    const summary = [...sends()].reverse().find((s) => String(s.text ?? '').includes('خلاصه سفارش'));
    const kbd = (summary?.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat();
    assert.equal(kbd.some((b) => b.callback_data === 'wlt:full'), false);
    assert.equal(kbd.some((b) => b.callback_data === 'wlt:part'), false);
    assert.equal(kbd.some((b) => b.callback_data === 'ord:confirm'), true);
    await dispatch(callbackUpdate('act:cancel', nextId()));
  } finally {
    sqlite.prepare("UPDATE settings SET value = ?1 WHERE key = 'wallet'").run(doc);
  }
});

// ————————————————————————— full wallet pay —————————————————————————

test('wlt:full pays, order is BORN approved — no receipt, no admin queue', async () => {
  const target = customerIdOf(USER.id);
  sqlite.prepare('UPDATE customers SET balance_irt = 400000 WHERE id = ?1').run(target);
  await purchaseToSummary(USER);
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));

  assert.equal(sessionFor(USER.id).state, 'IDLE');
  const order = sqlite
    .prepare("SELECT * FROM orders WHERE customer_id = ?1 AND kind = 'purchase' ORDER BY created_at DESC LIMIT 1")
    .get(target) as OrderRowLite & Record<string, unknown>;
  assert.equal(order.state, 'approved');
  assert.equal(Number(order.amount), 0); // remainder after full credit
  assert.equal(order.verified_by, 'wallet');
  assert.equal(balanceOf(target), 305000);
  const paid = sqlite
    .prepare("SELECT * FROM wallet_entries WHERE kind = 'order_payment' AND order_id = ?1")
    .get(order.id) as Record<string, unknown> | undefined;
  assert.ok(paid, 'payment ledger re-pointed onto the real order id');
  assert.equal(Number(paid['delta_irt']), -95000);
  const events = sqlite
    .prepare('SELECT action, to_state FROM order_events WHERE order_id = ?1 ORDER BY id')
    .all(order.id) as Array<Record<string, unknown>>;
  assert.equal(events[0]?.action, 'order_created_wallet_paid');
  assert.equal(events[0]?.to_state, 'approved');
  const t = sentTo(USER.id).map((s) => String(s.text ?? '')).join('\n');
  assert.ok(t.includes('پرداخت'));
  assert.equal(t.includes('فیش'), false); // never asks for a receipt
});

test('replayed wlt:full outside the confirm step is inert (no double debit)', async () => {
  const target = customerIdOf(USER.id);
  const balanceBefore = balanceOf(target);
  const paidBefore = sqlite
    .prepare("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND customer_id = ?1")
    .get(target)['n'] as number;
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
  assert.equal(balanceOf(target), balanceBefore);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND customer_id = ?1").get(target)['n'],
    paidBefore,
  );
});

// ————————————————————————— partial credit + refund —————————————————————————

test('partial credit: remainder through the untouched P4 pipeline, reject refunds', async () => {
  await dispatch(messageUpdateAs(USER2, '/start', nextId()));
  const target = customerIdOf(USER2.id);
  sqlite.prepare('UPDATE customers SET balance_irt = 30000 WHERE id = ?1').run(target);
  await purchaseToSummary(USER2);
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:part', nextId(), USER2));

  assert.equal(sessionFor(USER2.id).state, 'WAITING_PAYMENT_RECEIPT');
  const orderId = sessionFor(USER2.id).data['order_id'] as string;
  const order = orderById(orderId)!;
  assert.equal(order.state, 'pending_payment');
  assert.equal(order.amount, 65000); // 95000 − 30000 credit
  assert.equal(balanceOf(target), 0);
  assert.ok(/۶۵٬۰۰۰|65[٬,]?000/.test(textsTo(USER2.id).join('\n')), `t=${textsTo(USER2.id)}`);
  assert.ok(
    sqlite.prepare("SELECT * FROM wallet_entries WHERE kind = 'order_payment' AND order_id = ?1").get(orderId),
    'credit claimed on the order id',
  );

  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'PART_RECEIPT' }, USER2));
  assert.equal(orderById(orderId)?.state, 'awaiting_review');
  await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, 'فیش جعلی بود', nextId()));
  assert.equal(orderById(orderId)?.state, 'rejected');
  assert.equal(balanceOf(target), 30000);
  const refund = sqlite
    .prepare("SELECT * FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1")
    .get(orderId) as Record<string, unknown> | undefined;
  assert.ok(refund);
  assert.equal(Number(refund['delta_irt']), 30000);
  const customerTexts = textsTo(USER2.id);
  assert.ok(customerTexts.some((x) => x.includes('بازگشت')));
  // double-reject race: second admin tap is inert
  await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(balanceOf(target), 30000);
});

// ————————————————————————— referrals —————————————————————————

test('invite screen mints the code + deep link', async () => {
  stub.reset();
  await inviteWithGetMe(USER);
  const link = textsTo(USER.id).find((t) => t.includes('t.me/'));
  assert.ok(link, 'invite link shown');
  assert.match(link, /t\.me\/telbotv2_test\?start=ref_[0-9A-HJKMNP-TV-Z]{12}/);
  // inviteLinkNone is a FORMATTER: interpolating it raw used to ship the
  // function SOURCE («(link) => …») to the user. Pin the rendered copy instead.
  assert.ok(
    link.includes('🔗 لینک دعوت شما:\nhttps://t.me/'),
    'rendered label + URL on one block',
  );
  assert.doesNotMatch(link, /=>|\$\{|inviteLinkNone/, 'no source text leaks into the chat');
});

test('referral lifecycle: forged codes inert, first-touch fixed, capped once-per-referee payout', async () => {
  const NB1 = { id: 999000111, first_name: 'Sara', username: 'sara_new', language_code: 'fa' };
  const NB2 = { id: 999000112, first_name: 'Omid', username: 'omid_new', language_code: 'fa' };
  const NB3 = { id: 999000113, first_name: 'Kian', username: 'kian_new', language_code: 'fa' };
  // ensure USER owns a referral code (invite screen mints it; getMe stubbed)
  await inviteWithGetMe(USER);
  const code = sqlite
    .prepare('SELECT referral_code FROM customers WHERE telegram_user_id = ?1')
    .get(String(USER.id))['referral_code'] as string;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  const referrer = customerIdOf(USER.id);

  // 1) malformed code — registration proceeds, no attribution, never later.
  await dispatch(messageUpdateAs(NB1, '/start ref_BBBBBBBBBBB!', nextId()));
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(customerIdOf(NB1.id))['referred_by'], null);
  // 2) well-formed unknown code on FIRST start → still inert
  await dispatch(messageUpdateAs(NB2, '/start ref_QQQQQQQQQQQQ', nextId()));
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(customerIdOf(NB2.id))['referred_by'], null);
  // 3) NB2 is registered now → a VALID code afterwards does NOT attribute
  await dispatch(messageUpdateAs(NB2, `/start ref_${code}`, nextId()));
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(customerIdOf(NB2.id))['referred_by'], null);
  // 4) NB3 first-ever start carries the valid code → attributed forever
  await dispatch(messageUpdateAs(NB3, `/start ref_${code}`, nextId()));
  const nb3 = customerIdOf(NB3.id);
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(nb3)['referred_by'], referrer);
  await dispatch(messageUpdateAs(NB3, '/start ref_AAAAAAAAAAAA', nextId()));
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(nb3)['referred_by'], referrer);

  // 5) first approved purchase pays 10% of 95000 = 9500 (seeded percent doc).
  const before = balanceOf(referrer);
  await purchaseAndApprove(NB3, 'REF_RECEIPT');
  assert.equal(balanceOf(referrer), before + 9500);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM referral_rewards WHERE referred_customer_id = ?1').get(nb3)['n'], 1);
  // ... second approved purchase: no second payout
  setWalletCreditCap(10_000_000);
  await purchaseAndApprove(NB3, 'REF_RECEIPT2');
  assert.equal(balanceOf(referrer), before + 9500);

  // 6) wallet-paid (auto-approved) purchases also pay a payout exactly once
  sqlite.prepare('UPDATE customers SET balance_irt = 400000 WHERE id = ?1').run(nb3);
  // attribution already exists on nb3; but its referee payout was used.
  // Fresh referee NB4 first-start + wallet full pay:
  const NB4 = { id: 999000114, first_name: 'Nazanin', username: 'nazi_new', language_code: 'fa' };
  await dispatch(messageUpdateAs(NB4, `/start ref_${code}`, nextId()));
  const nb4 = customerIdOf(NB4.id);
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(nb4)['referred_by'], referrer);
  db_set_balance(NB4.id, 400000);
  await purchaseToSummary(NB4);
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:full', nextId(), NB4));
  await settleWaits();
  assert.equal(balanceOf(nb4), 305000);
  // payout fires via the wallet approval path too (provisioning is a no-op without panel)
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM referral_rewards WHERE referred_customer_id = ?1').get(nb4)['n'],
    1,
  );
  assert.equal(balanceOf(referrer), before + 19000); // two referees × 9500

  // 7) per-referrer cap: max 1 already satisfied? set cap 2 → no further rewards
  sqlite.prepare("UPDATE settings SET value = json_set(value, '$.max_rewards_per_referrer', 2) WHERE key = 'referral'").run();
  const NB5 = { id: 999000115, first_name: 'Poya', username: 'poya_new', language_code: 'fa' };
  await dispatch(messageUpdateAs(NB5, `/start ref_${code}`, nextId()));
  await purchaseAndApprove(NB5, 'CAP_RECEIPT');
  const payouts = sqlite.prepare('SELECT COUNT(*) n FROM referral_rewards').get()['n'] as number;
  assert.equal(payouts, 2); // capped by the doc (3rd referee blocked)
  sqlite.prepare("UPDATE settings SET value = json_set(value, '$.max_rewards_per_referrer', 20) WHERE key = 'referral'").run();

  // 8) malformed referral doc ⇒ payout no-op but purchase pipeline survives
  const doc = sqlite.prepare("SELECT value FROM settings WHERE key = 'referral'").get()['value'] as string;
  sqlite.prepare("UPDATE settings SET value = '{\"schema\": 9}' WHERE key = 'referral'").run();
  const NB6 = { id: 999000116, first_name: 'Raha', username: 'raha_new', language_code: 'fa' };
  await dispatch(messageUpdateAs(NB6, `/start ref_${code}`, nextId()));
  const b2 = balanceOf(referrer);
  await purchaseAndApprove(NB6, 'DOC_RECEIPT');
  assert.equal(balanceOf(referrer), b2);
  sqlite.prepare("UPDATE settings SET value = ?1 WHERE key = 'referral'").run(doc);
});

function db_set_balance(tgUserId: number, amount: number): void {
  sqlite.prepare('UPDATE customers SET balance_irt = ?2 WHERE telegram_user_id = ?1').run(String(tgUserId), amount);
}

function settleWaits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ————————————————————————— support —————————————————————————

let ticketId = '';

test('menu:ticket → first message opens ONE ticket, admins get buttons', async () => {
  await dispatch(messageUpdateAs(USER2, '/start', nextId())); // free any stale session
  stub.reset();
  await dispatch(callbackUpdateAs('menu:ticket', nextId(), USER2));
  assert.equal(sessionFor(USER2.id).state, 'WAITING_SUPPORT_MESSAGE');
  await dispatch(messageUpdateAs(USER2, 'سلام، لینک اشتراک من باز نمی‌شود.', nextId()));
  assert.equal(sessionFor(USER2.id).state, 'IDLE');
  const rows = sqlite.prepare('SELECT * FROM support_tickets WHERE customer_id = ?1').all(customerIdOf(USER2.id)) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  ticketId = String(rows[0]?.id);
  assert.match(ticketId, /^[0-9A-HJKMNP-TV-Z]{28}$/);
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('تیکت')));
  const push = sentTo(ADMIN.id).find((s) => {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data: string }[][] } | undefined;
    return kb?.inline_keyboard.flat().some((b) => b.callback_data === `tsk:rp:${ticketId}`);
  });
  assert.ok(push, 'push carries a Reply button addressing THIS ticket id');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM support_tickets WHERE customer_id = ?1 AND state IN ('open','answered')").get(customerIdOf(USER2.id))['n'],
    1,
  );
});

test('non-admin forged tsk callbacks are inert', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:cl:${ticketId}`, nextId(), USER));
  assert.equal(sqlite.prepare('SELECT state FROM support_tickets WHERE id = ?1').get(ticketId)['state'], 'open');
  const toast = stub.sent.find((x) => x.method === 'answerCallbackQuery');
  assert.ok(toast, 'neutral toast for forged ticket id');
});

test('admin reply reaches the customer, ticket flips answered; actions cleared', async () => {
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:rp:${ticketId}`, nextId(), ADMIN, ADMIN.id));
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('پاسخ خود را بنویسید')));
  await dispatch(messageUpdateAs(ADMIN, 'اپ را آپدیت کنید و دوباره باز کنید.', nextId()));
  assert.equal(sqlite.prepare('SELECT state FROM support_tickets WHERE id = ?1').get(ticketId)['state'], 'answered');
  assert.ok(textsTo(USER2.id).some((t) => t.includes('آپدیت')));
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ?1 AND sender LIKE 'admin:%'").get(ticketId)['n'],
    1,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM admin_actions').get()['n'], 0);
});

test('customer follow-up on a live ticket appends & re-notifies (IDLE routing)', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(USER2, 'همچنان مشکل دارد', nextId()));
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ?1 AND sender = 'customer'").get(ticketId)['n'],
    2,
  );
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('پیام جدید مشتری')));
  assert.equal(sessionFor(USER2.id).state, 'IDLE');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM support_tickets WHERE customer_id = ?1 AND state IN ('open','answered')").get(customerIdOf(USER2.id))['n'],
    1,
    'still exactly one live ticket',
  );
});

test('closing notifies the customer; stale closed-ticket buttons inert', async () => {
  assert.ok(ticketId, 'ticket exists from earlier test');
  const beforeClose = sqlite.prepare('SELECT state FROM support_tickets WHERE id = ?1').get(ticketId);
  if (!beforeClose || beforeClose.state === 'closed') {
    stub.reset();
    await dispatch(callbackUpdateAs('menu:ticket', nextId(), USER2));
    await dispatch(messageUpdateAs(USER2, 'دوباره نیاز به کمک دارم', nextId()));
    const row = sqlite.prepare("SELECT id FROM support_tickets WHERE customer_id = ?1 AND state IN ('open','answered') ORDER BY updated_at DESC LIMIT 1").get(customerIdOf(USER2.id));
    assert.ok(row, 're-opened');
    ticketId = String(row['id']);
  }
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:cl:${ticketId}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(sqlite.prepare('SELECT state FROM support_tickets WHERE id = ?1').get(ticketId)['state'], 'closed');
  assert.ok(textsTo(USER2.id).some((t) => t.includes('بسته شد')));
  const msgs = sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get()['n'] as number;
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:rp:${ticketId}`, nextId(), ADMIN, ADMIN.id));
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM admin_actions').get()['n'], 0, 'reply not armed');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get()['n'], msgs);
});

// ————————————————————————— announcements —————————————————————————

let announcementId = '';

test('/announce draft → confirm → fan-out is single-send per recipient', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/announce', nextId()));
  assert.equal(sessionFor(ADMIN.id).state, 'WAITING_ANNOUNCE_TEXT');
  await dispatch(messageUpdateAs(ADMIN, '🎉 تخفیف ویژه آغاز شد.', nextId()));
  assert.equal(sessionFor(ADMIN.id).state, 'WAITING_ANNOUNCE_CONFIRM');
  const confirm = [...sends()].reverse().find((s) => {
    const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data: string }[][] } | undefined;
    return kb?.inline_keyboard.flat().some((b) => b.callback_data.startsWith('ann:go:'));
  });
  assert.ok(confirm, 'summary shows send/cancel buttons');
  announcementId = String(
    (confirm?.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat().find((b) => b.callback_data.startsWith('ann:go:'))!.callback_data.slice('ann:go:'.length),
  );
  assert.match(announcementId, /^[0-9A-HJKMNP-TV-Z]{28}$/);
  // draft stored, nothing sent yet
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1').get(announcementId)['n'],
    0,
  );

  stub.reset();
  await dispatch(callbackUpdateAs(`ann:go:${announcementId}`, nextId(), ADMIN, ADMIN.id));
  const total = sqlite.prepare('SELECT COUNT(*) n FROM customers').get()['n'] as number;
  const sentRows = sqlite
    .prepare("SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1 AND status = 'sent'")
    .get(announcementId)['n'] as number;
  assert.equal(sentRows, total, 'one row per customer, all sent (single chunk)');
  assert.equal(
    sqlite.prepare('SELECT state FROM announcements WHERE id = ?1').get(announcementId)['state'],
    'done',
  );
  const perChat = new Map<string, number>();
  for (const s of stub.sent) {
    if (String(s.text ?? '').includes('تخفیف ویژه')) {
      const key = String(s.payload['chat_id']);
      perChat.set(key, (perChat.get(key) ?? 0) + 1);
    }
  }
  for (const [, count] of perChat) assert.equal(count, 1, 'exactly one copy per chat');
});

test('ann:go/ann:ct on a finished or foreign job stay inert; non-admin refused', async () => {
  const before = sqlite
    .prepare("SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1 AND status = 'sent'")
    .get(announcementId)['n'] as number;
  stub.reset();
  await dispatch(callbackUpdateAs(`ann:ct:${announcementId}`, nextId(), ADMIN, ADMIN.id)); // done job
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1 AND status = 'sent'").get(announcementId)['n'],
    before,
  );
  await dispatch(callbackUpdateAs(`ann:go:${announcementId}`, nextId(), USER)); // non-admin on done job
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1 AND status = 'sent'").get(announcementId)['n'],
    before,
  );
});

test('two drafts in flight cannot interleave sends (seed-once per job)', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/announce اطلاعیه الف', nextId()));
  await dispatch(callbackUpdate('act:cancel', nextId())); // abandon draft الف
  await dispatch(messageUpdateAs(ADMIN, '/announce اطلاعیه ب', nextId()));
  const ids = sqlite.prepare('SELECT id, body FROM announcements ORDER BY created_at ASC').all() as Array<{ id: string; body: string }>;
  // الف was abandoned before confirm → never seeded; only «ب» can confirm.
  const be = ids.find((r) => r.body === 'اطلاعیه ب');
  assert.ok(be);
  await dispatch(callbackUpdateAs(`ann:go:${be.id}`, nextId(), ADMIN, ADMIN.id));
  const stats = sqlite
    .prepare("SELECT announcement_id, COUNT(*) total, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) sent FROM announcement_deliveries GROUP BY announcement_id")
    .all() as Array<Record<string, unknown>>;
  for (const r of stats) {
    assert.equal(Number(r.total), Number(r.sent), 'no double-send');
  }
  const a = ids.find((r) => r.body === 'اطلاعیه الف');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) n FROM announcement_deliveries WHERE announcement_id = ?1').get(a!.id)['n'],
    0,
    'abandoned draft seeds nothing',
  );
});

test('/tickets queue is admin-only and buttons address live tickets', async () => {
  await dispatch(callbackUpdateAs('menu:ticket', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'سوال قبل از خرید', nextId()));
  const NB7 = { id: 999000117, first_name: 'Sep', username: 'sep_new', language_code: 'fa' };
  await dispatch(messageUpdateAs(NB7, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:ticket', nextId(), NB7));
  await dispatch(messageUpdateAs(NB7, 'قیمت‌ها چنده؟', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(USER, '/tickets', nextId()));
  assert.ok(textsTo(USER.id).some((t) => t.includes('دسترس')), `texts=${JSON.stringify(textsTo(USER.id))}`);
  await dispatch(messageUpdateAs(ADMIN, '/tickets', nextId()));
  const queue = sentTo(ADMIN.id).find((s) => String(s.text ?? '').includes('تیکت‌های باز'));
  assert.ok(queue);
  const kbd = (queue?.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  const ticketRows = sqlite.prepare("SELECT id, customer_id, state FROM support_tickets WHERE state IN ('open','answered')").all() as Array<{ id: string; customer_id: number; state: string }>;
  
  assert.ok(ticketRows.length >= 2, 'multiple live tickets listed');
  for (const row of ticketRows) {
    assert.ok(kbd.some((b) => b.callback_data === `tsk:vw:${row.id}`), `row for ${row.id.slice(0, 8)}`);
  }
});

// ————————————————————————— regression —————————————————————————

test('P3-P6 confirm-with-receipt path fully intact (zero wallet side effects)', async () => {
  const P7USER = { ...USER, id: 555111999, username: 'p7_plain' };
  const before = sqlite.prepare('SELECT COUNT(*) n FROM wallet_entries').get()['n'] as number;
  const orderId = await purchaseAndApprove(P7USER, 'PLAIN_RECEIPT');
  const order = orderById(orderId)!;
  assert.equal(order.state, 'approved');
  assert.equal(order.amount, 95000);
  assert.equal(Number(sqlite.prepare('SELECT COUNT(*) n FROM wallet_entries').get()['n']), before);
  const session = sessionFor(P7USER.id);
  assert.equal(session.state, 'IDLE'); // P4 approval clears the conversation
});

// ————————————————————————— P7 hardening (W1 / W2 / W5) —————————————————————————

function count(sql: string, ...args: unknown[]): number {
  const row = (sqlite.prepare(sql) as unknown as { get(...a: unknown[]): unknown }).get(...args) as
    | { n: number }
    | undefined;
  return row ? Number(row.n) : NaN;
}

type WalletDb = Parameters<typeof payOrderWithWallet>[0];

test('W1: order-payment claim is atomic, replay converges, index backstops', async () => {
  const s2 = freshDb();
  const d2 = makeD1Shim(s2) as unknown as WalletDb;
  s2.prepare(`INSERT INTO customers (telegram_user_id, first_name) VALUES ('777001', 'iso')`).run();
  const cid = (s2.prepare(`SELECT id FROM customers WHERE telegram_user_id = '777001'`).get() as { id: number }).id;
  const granted = await applyWalletMutation(d2, {
    customerId: cid,
    amountIrt: 100000,
    kind: 'admin_grant',
    actor: 'test',
  });
  if (!granted.ok) assert.fail('grant must succeed');

  const first = await payOrderWithWallet(d2, { customerId: cid, amountIrt: 60000, orderId: 'TOKW1', actor: 'customer' });
  if (!first.ok) assert.fail('claim should succeed');
  assert.equal(first.balance, 40000);

  // Sequential replay AND the concurrent-loser shape: same claim again moves nothing.
  const again = await payOrderWithWallet(d2, { customerId: cid, amountIrt: 60000, orderId: 'TOKW1', actor: 'customer' });
  if (!again.ok) assert.fail('already-paid converges ok');
  assert.equal(
    (s2.prepare('SELECT balance_irt FROM customers WHERE id = ?1').get(cid) as { balance_irt: number }).balance_irt,
    40000,
  );
  assert.equal(
    (s2.prepare(`SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND order_id = 'TOKW1'`).get() as { n: number }).n,
    1,
  );

  // Insufficient on a DIFFERENT order: zero side effects — no phantom ledger row.
  const low = await payOrderWithWallet(d2, { customerId: cid, amountIrt: 50000, orderId: 'TOKW2', actor: 'customer' });
  if (low.ok) assert.fail('must decline');
  assert.equal(low.reason, 'insufficient');
  assert.equal(
    (s2.prepare('SELECT balance_irt FROM customers WHERE id = ?1').get(cid) as { balance_irt: number }).balance_irt,
    40000,
  );
  assert.equal(
    (s2.prepare(`SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND order_id = 'TOKW2'`).get() as { n: number }).n,
    0,
  );

  // Hard backstop: a second 'order_payment' for the same order id cannot exist.
  let dupThrew = false;
  try {
    s2.prepare(
      `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
       VALUES ('DUPW1', ?1, -1, 'order_payment', 'TOKW1', 'x', 40000)`,
    ).run(cid);
  } catch {
    dupThrew = true;
  }
  assert.ok(dupThrew, 'idx_wallet_payment_once rejects a duplicate payment row');
});

test('W2: wallet-full purchase checkout hard-fail refunds exactly once', async () => {
  const target = customerIdOf(USER.id);
  sqlite.prepare('UPDATE customers SET balance_irt = 400000 WHERE id = ?1').run(target);
  const token = await purchaseToSummary(USER);
  sqlite.exec(`CREATE TRIGGER orders_boom_p AFTER INSERT ON orders BEGIN SELECT RAISE(ABORT, 'orders_boom_p'); END`);
  try {
    stub.reset();
    await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
    assert.equal(balanceOf(target), 400000, 'the claimed debit is refunded');
    assert.equal(sessionFor(USER.id).state, 'WAITING_ORDER_CONFIRMATION', 'flow stays resumable');
    assert.equal(count('SELECT COUNT(*) n FROM orders WHERE idempotency_key = ?1', token), 0);
    assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND order_id = ?1", token), 1);
    assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1", token), 1);
    assert.equal(
      Number((sqlite.prepare("SELECT delta_irt v FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1").get(token) as { v: number }).v),
      95000,
    );

    // Retry with the failure still in place: never a second refund or debit.
    await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
    assert.equal(balanceOf(target), 400000);
    assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1", token), 1);
    assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_payment' AND order_id = ?1", token), 1);
  } finally {
    sqlite.exec('DROP TRIGGER orders_boom_p');
  }
  await dispatch(callbackUpdate('act:cancel', nextId()));
});

test('W2: wallet-full renewal checkout hard-fail refunds exactly once', async () => {
  const target = customerIdOf(USER.id);
  const service = sqlite
    .prepare(`SELECT id FROM orders WHERE customer_id = ?1 AND kind = 'purchase' AND state = 'approved' ORDER BY created_at DESC LIMIT 1`)
    .get(target) as { id: string } | undefined;
  assert.ok(service, 'USER owns an approved purchase to renew');
  sqlite.prepare(`UPDATE orders SET state = 'completed' WHERE id = ?1`).run(service.id);
  sqlite.prepare('UPDATE customers SET balance_irt = 200000 WHERE id = ?1').run(target);
  try {
    await dispatch(callbackUpdateAs(`svc:rnw:${service.id}`, nextId(), USER));
    assert.equal(sessionFor(USER.id).state, 'WAITING_RENEWAL_DURATION');
    await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
    assert.equal(sessionFor(USER.id).state, 'WAITING_RENEWAL_CONFIRMATION');
    const token = String(sessionFor(USER.id).data['order_token']);
    sqlite.exec(`CREATE TRIGGER orders_boom_r AFTER INSERT ON orders BEGIN SELECT RAISE(ABORT, 'orders_boom_r'); END`);
    try {
      stub.reset();
      await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
      assert.equal(balanceOf(target), 200000, 'renewal debit refunded');
      assert.equal(count('SELECT COUNT(*) n FROM orders WHERE idempotency_key = ?1', token), 0);
      assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1", token), 1);

      // Retry: exactly-once holds on the renewal path too.
      await dispatch(callbackUpdateAs('wlt:full', nextId(), USER));
      assert.equal(balanceOf(target), 200000);
      assert.equal(count("SELECT COUNT(*) n FROM wallet_entries WHERE kind = 'order_refund' AND order_id = ?1", token), 1);
    } finally {
      sqlite.exec('DROP TRIGGER orders_boom_r');
    }
    await dispatch(callbackUpdate('act:cancel', nextId()));
  } finally {
    sqlite.prepare(`UPDATE orders SET state = 'approved' WHERE id = ?1`).run(service.id);
  }
});

test('W5: percent reward math + config bounds (pure)', () => {
  assert.equal(referralRewardIrt(360001, 10), 36000);
  assert.equal(referralRewardIrt(999, 1), 9);
  assert.equal(referralRewardIrt(99, 1), 0);
  assert.equal(referralRewardIrt(360000, 100), 360000);
  assert.equal(referralRewardIrt(1_000_000_000_000, 100), 1_000_000_000_000);
  assert.equal(referralRewardIrt(0, 10), 0);
  assert.equal(referralRewardIrt(500, 2.5), 0);
  assert.equal(referralRewardIrt(500.5, 10), 0);
  assert.equal(referralRewardIrt(500, 0), 0);
  assert.equal(referralRewardIrt(500, 101), 0);
  assert.equal(referralRewardIrt(Number.MAX_SAFE_INTEGER, 100), 0);

  assert.ok(parseReferralConfig({ schema: 1, enabled: true, reward_percent: 10, max_rewards_per_referrer: 5 }).ok);
  for (const bad of [0, 101, 10.5, '10', null, undefined]) {
    assert.ok(
      !parseReferralConfig({ schema: 1, enabled: true, reward_percent: bad, max_rewards_per_referrer: 5 }).ok,
      `percent ${String(bad)} must fail closed`,
    );
  }
  assert.ok(!parseReferralConfig({ schema: 1, enabled: true, max_rewards_per_referrer: 5 }).ok, 'missing percent');
  assert.ok(
    !parseReferralConfig({ schema: 1, enabled: true, reward_amount_irt: 50000, max_rewards_per_referrer: 5 }).ok,
    'legacy fixed-amount doc no longer parses',
  );
});

test('W5: live payout is percent of amount+credit, zero floors to no-op, renewal never pays', async () => {
  const code = (sqlite
    .prepare('SELECT referral_code FROM customers WHERE telegram_user_id = ?1')
    .get(String(USER.id)) as { referral_code: string }).referral_code;
  const referrer = customerIdOf(USER.id);
  const payoutApi = { sendMessage: async () => true } as unknown as Parameters<typeof payReferrerIfDue>[1];
  const payoutDb = shim as unknown as Parameters<typeof payReferrerIfDue>[0];
  const synth = (
    customerId: number,
    id: string,
    amount: number,
    selections: string,
    kind: string,
  ) =>
    ({ id, customer_id: customerId, state: 'approved', kind, selections, amount, currency: 'IRT' }) as unknown as
      Parameters<typeof payReferrerIfDue>[2];

  const NB9 = { id: 999000119, first_name: 'Zara', username: 'zara_synth', language_code: 'fa' };
  const NB10 = { id: 999000120, first_name: 'Kam', username: 'kam_synth', language_code: 'fa' };
  await dispatch(messageUpdateAs(NB9, `/start ref_${code}`, nextId()));
  const nb9 = customerIdOf(NB9.id);
  await dispatch(messageUpdateAs(NB10, `/start ref_${code}`, nextId()));
  const nb10 = customerIdOf(NB10.id);
  assert.equal(sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(nb9)['referred_by'], referrer);

  const doc = sqlite.prepare("SELECT value FROM settings WHERE key = 'referral'").get()['value'] as string;
  try {
    const before = balanceOf(referrer);
    // percent 1 on a tiny order floors to 0 → NOTHING pays, the slot stays free
    sqlite.prepare("UPDATE settings SET value = json_set(value, '$.reward_percent', 1) WHERE key = 'referral'").run();
    await payReferrerIfDue(payoutDb, payoutApi, synth(nb9, 'SYNTH000000000000000000000001', 50, '{}', 'purchase'), 'test');
    assert.equal(balanceOf(referrer), before, 'floored to zero: nothing pays');
    assert.equal(count('SELECT COUNT(*) n FROM referral_rewards WHERE referred_customer_id = ?1', nb9), 0, 'slot free');

    // percent 10 over amount + wallet credit: floor((324000 + 36000) × 10%) = 36000
    sqlite.prepare("UPDATE settings SET value = json_set(value, '$.reward_percent', 10) WHERE key = 'referral'").run();
    await payReferrerIfDue(
      payoutDb,
      payoutApi,
      synth(nb9, 'SYNTH000000000000000000000002', 324000, '{"wallet":{"mode":"full","credit_irt":36000}}', 'purchase'),
      'test',
    );
    assert.equal(balanceOf(referrer), before + 36000, '10% of the FULL purchase total');
    assert.equal(
      Number((sqlite.prepare('SELECT amount_irt v FROM referral_rewards WHERE referred_customer_id = ?1').get(nb9) as { v: number }).v),
      36000,
    );

    // once per referee ever: the NEXT purchase pays nothing more
    await payReferrerIfDue(payoutDb, payoutApi, synth(nb9, 'SYNTH000000000000000000000003', 999999, '{}', 'purchase'), 'test');
    assert.equal(balanceOf(referrer), before + 36000, 'exactly once per referee');

    // renewal-kind orders never trigger a payout
    await payReferrerIfDue(payoutDb, payoutApi, synth(nb10, 'SYNTH000000000000000000000004', 360000, '{}', 'renewal'), 'test');
    assert.equal(balanceOf(referrer), before + 36000, 'renewals never pay referrals');
    assert.equal(count('SELECT COUNT(*) n FROM referral_rewards WHERE referred_customer_id = ?1', nb10), 0);
  } finally {
    sqlite.prepare("UPDATE settings SET value = ?1 WHERE key = 'referral'").run(doc);
  }
});

// ————————————————————————— admin relay failure visibility —————————————————————————

test('no admin configured: ticket still opens + customer keeps the confirmation, relay failure is LOGGED only', async () => {
  const NOADMIN_USER = {
    id: 999000777,
    first_name: 'Nima',
    username: 'relay_silent',
    language_code: 'fa',
  };
  const prevEnv = env as unknown as Record<string, unknown>;
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    delete prevEnv['ADMIN_CHAT_ID']; // no env admin, and no is_admin rows in this DB
    stub.reset();
    await dispatch(messageUpdateAs(NOADMIN_USER, '/start', nextId()));
    await dispatch(callbackUpdateAs('menu:ticket', nextId(), NOADMIN_USER));
    await dispatch(messageUpdateAs(NOADMIN_USER, 'لینک من باز نمی‌شود', nextId()));

    const row = sqlite
      .prepare('SELECT id, state FROM support_tickets WHERE customer_id = ?1')
      .get(String(customerIdOf(NOADMIN_USER.id))) as { id: string; state: string } | undefined;
    assert.ok(row, 'ticket row committed even though nothing could be relayed');
    assert.equal(row?.state, 'open');
    assert.equal(
      sqlite
        .prepare('SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ?1')
        .get(String(row?.id))['n'],
      1,
    );
    // The customer-facing copy is unchanged: presence/absence of admins is
    // operator configuration and must never leak into their chat.
    assert.ok(
      textsTo(NOADMIN_USER.id).some((x) => x.includes('درخواستت ثبت شد')),
      'customer still told the ticket was registered',
    );
    assert.ok(
      !textToBlob(NOADMIN_USER.id).includes(String(ADMIN.id)),
      'admin id never appears in customer messages',
    );
    assert.deepEqual(sentTo(ADMIN.id), [], 'nothing reached any admin chat');
    const failures = logged.filter((l) => l.includes('ticket_admin_notify_failed'));
    assert.equal(failures.length, 1);
    assert.ok(failures[0]?.includes(String(row?.id)), 'log carries the ticket id');
    assert.ok(
      !failures[0]?.includes('ADMIN_CHAT_ID') && !failures[0]?.includes(String(ADMIN.id)),
      'log names the failure without exposing admin configuration',
    );

    // Follow-up on the live ticket hits the SAME relay gate (second site).
    logged.length = 0;
    await dispatch(messageUpdateAs(NOADMIN_USER, 'همچنان درست نشد', nextId()));
    assert.equal(
      logged.filter((l) => l.includes('ticket_admin_notify_failed')).length,
      1,
      'follow-up relay failure logged once as well',
    );
    assert.equal(
      sqlite
        .prepare('SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ?1')
        .get(String(row?.id))['n'],
      2,
      'follow-up appended (DB stays the truth)',
    );
  } finally {
    console.error = realError;
    prevEnv['ADMIN_CHAT_ID'] = String(ADMIN.id);
  }
});

function textToBlob(chatId: number): string {
  return textsTo(chatId).join('\n');
}

// ————————————————————————— ticket display code uniqueness —————————————————————————

test('T-DUP: two tickets minted side by side get DISTINCT 8-char display codes, ids still full-size', async () => {
  const A = { id: 999000801, first_name: 'Nilou', username: 'code_dup_a', language_code: 'fa' };
  const B = { id: 999000802, first_name: 'Kaveh', username: 'code_dup_b', language_code: 'fa' };
  const ticketOf = (user: typeof A): string => {
    const row = sqlite
      .prepare('SELECT id FROM support_tickets WHERE customer_id = ?1')
      .get(String(customerIdOf(user.id))) as { id: string } | undefined;
    assert.ok(row, `ticket row for ${user.username}`);
    return row.id;
  };

  stub.reset();
  for (const user of [A, B]) {
    await dispatch(messageUpdateAs(user, '/start', nextId()));
    await dispatch(callbackUpdateAs('menu:ticket', nextId(), user));
    await dispatch(messageUpdateAs(user, 'سلام، میخوام لینکم باز بشه', nextId()));
  }
  const aId = ticketOf(A);
  const bId = ticketOf(B);
  // Customer copy is captured BEFORE any stub.reset(): full id on creation.
  const aCreation = textsTo(A.id);
  assert.notEqual(aId, bId, 'two distinct tickets exist');
  for (const id of [aId, bId]) {
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{28}$/, 'primary keys stay full ULIDs');
  }

  // The display path is what changed: tsk:vw renders the ticket-view header.
  const codeOfView = async (orderId: string): Promise<string> => {
    stub.reset();
    await dispatch(callbackUpdateAs(`tsk:vw:${orderId}`, nextId(), ADMIN, ADMIN.id));
    const text = textsTo(ADMIN.id).at(-1) ?? '';
    const match = /🎫 ([0-9A-HJKMNP-TV-Z]{8}) —/.exec(text);
    assert.ok(match, `ticket view carries an 8-char code (got: ${JSON.stringify(text.slice(0, 40))})`);
    return String(match?.[1]);
  };
  const aCode = await codeOfView(aId);
  const bCode = await codeOfView(bId);
  assert.notEqual(aCode, bCode, 'displayed codes differ even for tickets minted in the same instant');
  assert.ok(aId.endsWith(aCode) && bId.endsWith(bCode), 'code is the id TAIL — the 80-bit random end, not the timestamp head the old slice(0,8) printed (that is what made same-bucket tickets collide)');
  assert.notEqual(aCode, aId.slice(0, 8), 'the old head-slice value is gone from the display');

  // Identity on the wire is untouched: the code just rendered is NOT an
  // actionable reference — a ticket is addressed by its full 28-char id only
  // (which is exactly what the two successful `tsk:vw:<full id>` views above
  // proved). A short-code callback stays inert.
  for (const code of [aCode, bCode]) {
    stub.reset();
    await dispatch(callbackUpdateAs(`tsk:vw:${code}`, nextId(), ADMIN, ADMIN.id));
    assert.equal(
      textsTo(ADMIN.id).filter((x) => x.includes('🎫')).length,
      0,
      `display code ${code} addresses no ticket`,
    );
  }
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:vw:${aId}`, nextId(), ADMIN, ADMIN.id));
  const viewButtons = stub.sent
    .flatMap((s) => {
      const kb = s.payload['reply_markup'] as
        | { inline_keyboard?: { callback_data: string }[][] }
        | undefined;
      return kb?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
    });
  assert.deepEqual(
    viewButtons.sort(),
    [`tsk:cl:${aId}`, `tsk:rp:${aId}`, `tsk:vw:${aId}`].sort(),
    'ticket actions still carry the FULL id (`adm:`/`tsk:` ULID discipline unchanged)',
  );

  // Customer copy: FULL id on creation, unchanged short form on the
  // existing-ticket reminder (`supportTicketExists` keeps its own copy — this
  // fix touched only the admin display code, per the agreed scope).
  assert.ok(aCreation.some((x) => x.includes(aId)), 'customer sees the FULL ticket id');
  stub.reset();
  await dispatch(callbackUpdateAs('menu:ticket', nextId(), A));
  assert.ok(
    (textsTo(A.id).at(-1) ?? '').includes(`(${aId.slice(0, 10)}…)`),
    'existing-ticket notice copy is byte-identical to before the fix',
  );
});

// ————————————————————————— referral code entropy / unpredictability —————————————————————————

test('R1: referral codes are CSPRNG-minted, never a timestamp slice', () => {
  const codes = Array.from({ length: 400 }, () => newReferralCode());
  // Storage contract unchanged: every mint satisfies the existing validator…
  for (const code of codes) {
    assert.equal(isReferralCode(code), true, `stored format intact (${code})`);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/, 'same length + alphabet as before');
  }
  // …and two codes minted microseconds apart are never identical.
  assert.equal(new Set(codes).size, codes.length, 'no collisions in one burst');
  // The old generator leaked Date.now() into EVERY character position above ms
  // resolution, so a whole burst shared its leading 4 chars. Randomness must
  // not collapse to one bucket.
  assert.ok(
    new Set(codes.map((c) => c.slice(0, 4))).size > 50,
    'leading characters spread across the alphabet, not one time bucket',
  );
  const timeHead = newOrderId().slice(0, 4); // the timestamp prefix, e.g. '0001'
  const headMatches = codes.filter((c) => c.startsWith(timeHead)).length;
  assert.ok(headMatches <= 1, `only chance puts ${timeHead} at the head (got ${headMatches})`);
  assert.notEqual(newOrderId().slice(0, 12), codes[0], 'code is not the order-id time prefix');
});

test('R2: a minted code stores, idles idempotently, appears in the invite link, and still attributes', async () => {
  const REFERRER = { id: 999000871, first_name: 'Mina', username: 'entropy_ref', language_code: 'fa' };
  const REFEREE = { id: 999000872, first_name: 'Kian', username: 'entropy_referee', language_code: 'fa' };
  const db = shim as unknown as Parameters<typeof ensureReferralCode>[0];

  stub.reset();
  await dispatch(messageUpdateAs(REFERRER, '/start', nextId()));
  const referrerId = customerIdOf(REFERRER.id);
  const code = await ensureReferralCode(db, referrerId);
  assert.ok(code && isReferralCode(code), 'lazy mint produces a valid code');
  await ensureReferralCode(db, referrerId);
  assert.equal(
    sqlite.prepare('SELECT referral_code FROM customers WHERE id = ?1').get(String(referrerId))['referral_code'],
    code,
    'second call is idempotent — the stored code never rotates',
  );

  // The invite screen shows exactly the stored code (formatter behavior kept).
  await inviteWithGetMe(REFERRER);
  assert.ok(
    textsTo(REFERRER.id).some((x) => x.includes(`?start=ref_${code}`)),
    'invite deep link carries the minted code',
  );
  assert.ok(
    textsTo(REFERRER.id).some((x) => x.includes('🔗 لینک دعوت شما:')),
    'invite copy still renders through the formatter',
  );

  // Attribution over the new-format code: the deep link must be the referee's
  // FIRST-EVER /start (first-touch by design — no prior plain /start).
  await dispatch(messageUpdateAs(REFEREE, `/start ref_${code}`, nextId()));
  assert.equal(
    sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(String(customerIdOf(REFEREE.id)))['referred_by'],
    referrerId,
    'first-touch attribution works with a CSPRNG code',
  );
  // A forged/truncated code of the same shape stays inert.
  const OTHER = { id: 999000873, first_name: 'Roya', username: 'entropy_forged', language_code: 'fa' };
  const last = String(code).slice(-1);
  const nearMiss = String(code).slice(0, 11) + (last === 'B' ? 'A' : 'B');
  assert.notEqual(nearMiss, code, 'the forged code really differs');
  await dispatch(messageUpdateAs(OTHER, `/start ref_${nearMiss}`, nextId()));
  assert.equal(
    sqlite.prepare('SELECT referred_by FROM customers WHERE id = ?1').get(String(customerIdOf(OTHER.id)))['referred_by'],
    null,
    'a near-miss code attributes nothing',
  );
});

// ————————————————————————— direct support vs ticket —————————————————————————

test('menu:support opens NO ticket (fails closed when SUPPORT_CONTACT is unset)', async () => {
  const hero = { ...USER, id: 222333999, username: 'support_direct', language_code: 'fa' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const ticketsBefore = Number(sqlite.prepare('SELECT COUNT(*) n FROM support_tickets').get()['n']);
  stub.reset();
  await dispatch(callbackUpdateAs('menu:support', nextId(), hero));   // direct support
  const ticketsAfter = Number(sqlite.prepare('SELECT COUNT(*) n FROM support_tickets').get()['n']);
  assert.equal(ticketsAfter, ticketsBefore, 'support button creates no ticket row');
  assert.equal(sessionFor(hero.id).state, 'IDLE', 'support button never changes session state');
  // No admin relay fires for a mere support tap.
  assert.ok(!sentTo(ADMIN.id).some((s) => String(s.text).includes('تیکت')), 'no admin ticket push');
  const copy = textsTo(hero.id).join(' | ');
  assert.ok(/مستقیم/.test(copy), 'the direct-support surface is named');
  assert.ok(!/ثبت شد/.test(copy), 'no false "ticket submitted" confirmation');
});

test('menu:ticket is the ladder: composing state then a real tracked ticket', async () => {
  const hero = { ...USER, id: 222333998, username: 'ticket_ladder', language_code: 'fa' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const ticketsBefore = Number(sqlite.prepare('SELECT COUNT(*) n FROM support_tickets').get()['n']);
  stub.reset();
  await dispatch(callbackUpdateAs('menu:ticket', nextId(), hero));
  assert.equal(sessionFor(hero.id).state, 'WAITING_SUPPORT_MESSAGE', 'ticket button enters composing');
  // composing keyboard hides the main labels
  const kb = (sentTo(hero.id).at(-1)!.payload['reply_markup'] as { keyboard?: { text: string }[][] });
  assert.ok(kb.keyboard.flat().every((b) => !['\U0001f6d2 خرید سرویس'].includes(b.text)), 'menu hidden while composing');
  await dispatch(messageUpdateAs(hero, 'لینک من باز نمی‌شود', nextId()));
  const ticketsAfter = Number(sqlite.prepare('SELECT COUNT(*) n FROM support_tickets').get()['n']);
  assert.equal(ticketsAfter, ticketsBefore + 1, 'ticket ladder reached -> exactly one ticket created');
  assert.ok(
    sentTo(ADMIN.id).some((s) => {
      const k = s.payload['reply_markup'] as { inline_keyboard?: { callback_data: string }[][] } | undefined;
      return k?.inline_keyboard.flat().some((b) => /^tsk:rp:/.test(b.callback_data));
    }),
    'admin queue got a replyable ticket',
  );
});

test('support and ticket are two DISTINCT buttons with two distinct callbacks', async () => {
  const { menuCallbackForText, CB: Callbacks } = await import('../src/telegram/menu.ts');
  const { FA_UI, EN_UI } = await import('../src/telegram/i18n.ts');
  assert.equal(menuCallbackForText(FA_UI.t.menuSupport), Callbacks.MENU_SUPPORT);
  assert.equal(menuCallbackForText(FA_UI.t.menuTicket), Callbacks.MENU_TICKET);
  assert.equal(menuCallbackForText(EN_UI.t.menuSupport), Callbacks.MENU_SUPPORT);
  assert.equal(menuCallbackForText(EN_UI.t.menuTicket), Callbacks.MENU_TICKET);
  assert.notEqual(Callbacks.MENU_SUPPORT, Callbacks.MENU_TICKET);
  assert.notEqual(Callbacks.MENU_TICKET, Callbacks.MENU_TICKETS, 'customer ticket never collides with the admin queue');
});
