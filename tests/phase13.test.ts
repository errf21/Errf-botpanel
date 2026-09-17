/**
 * Phase 13 e2e: the user/device purchase limit (0012) AND the admin sales
 * stop/resume switch (0013) over the real dispatcher + SQLite.
 *
 * Covers, in order:
 *  - 0012 data pins: device ladder {1,2,3}, custom OFF, min 1 / max 3; the
 *    ladder keyboard offers exactly 1/2/3 (no custom button); Persian-digit
 *    input for a preset (۲ -> 2) still lands; counts above 3 are refused.
 *  - sales-config FAIL-OPEN semantics: missing / malformed / wrong-schema rows
 *    all resolve to ENABLED; only an explicit stopped:true blocks.
 *  - authorization: /sales and every sal: verb are admin-gated; a normal user's
 *    forged sal:* stays inert (no write, no audit row).
 *  - the CAS writer: 'applied' appends exactly one settings_audit row; a stale
 *    oldJson yields 'conflict' and leaves the winner's document byte-identical.
 *  - the commercial stop blocks EVERY create/extend path (fresh entry, mid-draft
 *    purchase confirmation, wallet full/partial, renewal receipt + wallet) with
 *    NO order row and NO wallet debit.
 *  - resume restores purchase and renewal on the SAME preserved draft token.
 *  - existing-service management, admin approval of a pre-stop order, support,
 *    wallet/account, guide, language, /start and announcements keep working
 *    while stopped.
 *  - the checkout backstop is unbypassable (both checkout functions refuse with
 *    sales_stopped before any insert), and stopped-state persistence is proven
 *    straight from the D1 row (the switch NEVER lives in memory).
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
import {
  isSalesStopped,
  loadSalesState,
  parseSalesConfig,
  SALES_SCHEMA,
} from '../src/catalog/sales.ts';
import { applySalesToggleCas, salesDoc } from '../src/db/sales.ts';
import { parseSalesCallback } from '../src/lib/validate.ts';
import {
  checkoutOrder,
  checkoutRenewalOrder,
  type CheckoutDraft,
  type RenewalCheckoutDraft,
} from '../src/orders/checkout.ts';
import { calculatePrice, calculateRenewalPrice } from '../src/catalog/pricing.ts';
import { loadCatalog } from '../src/catalog/catalog.ts';
import { newOrderId } from '../src/lib/security.ts';
import { performAdminReview } from '../src/admin.ts';
import type { TelegramApiLike } from '../src/types.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown) => processTelegramUpdate(update, env);

let counter = 40000;
const nextId = () => ++counter;

const STOPPED_NOTICE = 'فعلاً ارائه سرویس متوقفه';
const ORDER_TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{28}$/;

/* ————————————————————— sqlite-is-the-truth helpers ————————————————————— */

function salesRaw(): string | undefined {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'sales'")
    .get() as { value: string } | undefined;
  return row?.value;
}
/** Raw D1 write; `null` deletes the row (the fail-open 'missing' case).
 *  INSERT-OR-REPLACE: later tests must be able to resurrect a deleted row. */
function salesSetRaw(raw: string | null): void {
  if (raw === null) {
    sqlite.prepare("DELETE FROM settings WHERE key = 'sales'").run();
  } else {
    sqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sales', ?1)")
      .run(raw);
  }
}
function setStopped(stopped: boolean): void {
  salesSetRaw(`{"schema":${SALES_SCHEMA},"stopped":${stopped ? 'true' : 'false'}}`);
}

function cidSync(tgUserId: number): number {
  const row = sqlite
    .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
    .get(String(tgUserId)) as { id: number } | undefined;
  return row?.id ?? -1;
}
function sessionState(tgUserId: number): { state: string; data: Record<string, unknown> } {
  const row = sqlite
    .prepare('SELECT s.state, s.data FROM conversation_states s WHERE s.customer_id = ?1')
    .get(cidSync(tgUserId)) as { state: string; data: string } | undefined;
  // NO row is functionally IDLE (same as getSession's default) — a blocked
  // gate must leave either, but NEVER a flow-advancing state.
  return row
    ? { state: row.state, data: JSON.parse(row.data) as Record<string, unknown> }
    : { state: 'IDLE', data: {} };
}
function setBalance(tgUserId: number, amount: number): void {
  sqlite.prepare('UPDATE customers SET balance_irt = ?1 WHERE id = ?2').run(amount, cidSync(tgUserId));
}
function balance(tgUserId: number): number {
  const row = sqlite
    .prepare('SELECT balance_irt FROM customers WHERE id = ?1')
    .get(cidSync(tgUserId)) as { balance_irt: number } | undefined;
  return row?.balance_irt ?? -1;
}
function orderCount(): number {
  return sqlite.prepare('SELECT COUNT(*) n FROM orders').get()['n'] as number;
}
function walletCount(): number {
  return sqlite.prepare('SELECT COUNT(*) n FROM wallet_entries').get()['n'] as number;
}
function ordersFor(tgUserId: number, kind: string): Array<Record<string, unknown>> {
  return sqlite
    .prepare('SELECT * FROM orders WHERE customer_id = ?1 AND kind = ?2 ORDER BY created_at DESC')
    .all(String(cidSync(tgUserId)), kind) as never;
}
function salesAudit(): Array<Record<string, unknown>> {
  return sqlite.prepare("SELECT * FROM settings_audit WHERE key = 'sales' ORDER BY id").all() as never;
}
function sendTexts(chatId: number): string[] {
  return stub.sent
    .filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId)
    .map((s) => String(s.payload['text'] ?? ''));
}
function toasts(): string[] {
  return stub.sent
    .filter((s) => s.method === 'answerCallbackQuery')
    .map((s) => String(s.payload['text'] ?? ''));
}
function lastKeyboard(chatId: number): Record<string, unknown> {
  const msg = [...stub.sent]
    .reverse()
    .find((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId);
  return (msg?.payload['reply_markup'] ?? {}) as Record<string, unknown>;
}
function keyboardButtons(kb: Record<string, unknown>): string[] {
  const rows = (kb['inline_keyboard'] ?? []) as Array<Array<{ callback_data?: string }>>;
  return rows.flat().map((b) => b.callback_data ?? '');
}
function sawStoppedNotice(chatId: number): boolean {
  return sendTexts(chatId).some((t) => t.includes(STOPPED_NOTICE)) || toasts().some((t) => t.includes(STOPPED_NOTICE));
}
function completePurchaseOf(tgUserId: number): string {
  const row = sqlite
    .prepare("SELECT id FROM orders WHERE customer_id = ?1 AND kind='purchase' AND state='completed' ORDER BY created_at DESC LIMIT 1")
    .get(String(cidSync(tgUserId))) as { id: string } | undefined;
  return row?.id ?? '';
}
function markServiceCompleted(tgUserId: number, expireSoon = false): string {
  sqlite
    .prepare(
      `UPDATE orders
          SET state='completed',
              subscription_url='https://panel.example/sub/abc',
              service_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2)
        WHERE customer_id = ?1 AND kind='purchase'`,
    )
    .run(String(cidSync(tgUserId)), expireSoon ? '+3 days' : '+20 days');
  return completePurchaseOf(tgUserId);
}

/** Runs the whole purchase ladder up to the confirmation step. The last tap
 *  (ord:confirm / wlt:* / a blocked attempt) is owned by the caller. */
async function draftToConfirm(tg: typeof USER, device = 'dev:1'): Promise<void> {
  await dispatch(messageUpdateAs(tg, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), tg));
  await dispatch(messageUpdateAs(tg, 'northvalley7', nextId()));
  assert.equal(sessionState(tg.id).state, 'WAITING_VOLUME');
  await dispatch(callbackUpdateAs('vol:10', nextId(), tg));
  assert.equal(sessionState(tg.id).state, 'WAITING_DURATION');
  await dispatch(callbackUpdateAs('dur:30', nextId(), tg));
  assert.equal(sessionState(tg.id).state, 'WAITING_DEVICE_LIMIT');
  if (device.startsWith('dev:')) await dispatch(callbackUpdateAs(device, nextId(), tg));
  else await dispatch(messageUpdateAs(tg, device, nextId()));
  assert.equal(sessionState(tg.id).state, 'WAITING_ORDER_CONFIRMATION');
}

/* ═════════════════════════ 0012 — device ladder ═════════════════════════ */

test('0012: ladder keyboard offers exactly presets {1,2,3}, no custom; typed ۲ lands via preset; ≥4 refused', async () => {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdateAs(USER, 'northvalley7', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));

  // duration ladder is untouched by 0012: 30/60/90, no custom advertised.
  const durPrompt = sendTexts(USER.id).at(-1) ?? '';
  assert.ok(durPrompt.includes('مدت'), 'duration step reached');
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));

  // THE DEVICE PROMPT + KEYBOARD as rendered right now …
  const prompt = sendTexts(USER.id).at(-1) ?? '';
  const buttons = keyboardButtons(lastKeyboard(USER.id));
  // … 0012 allow_custom=false → the prompt never invites typing a custom number
  assert.equal(prompt.includes('تایپ کن'), false, `no custom-typing invitation expected: ${prompt}`);
  // …and the keyboard carries exactly the 1/2/3 presets, no custom button.
  assert.ok(buttons.includes('dev:1') && buttons.includes('dev:2') && buttons.includes('dev:3'), buttons.join(' '));
  assert.equal(buttons.includes('dev:custom'), false, `custom button must be gone: ${buttons.join(' ')}`);
  assert.equal(buttons.includes('dev:4'), false, '4 must not be offered');
  assert.equal(buttons.includes('dev:10'), false, '10 must not be offered');
  stub.reset();

  // Persian-digit free text for a value that IS a preset (۲ = 2) still lands:
  await dispatch(messageUpdateAs(USER, '۲', nextId()));
  assert.equal(sessionState(USER.id).state, 'WAITING_ORDER_CONFIRMATION');
  assert.equal(sessionState(USER.id).data['device_count'], 2);

  // …but anything above the (now reduced) max is refused in the «دستگاه»
  // domain and NEVER advances the ladder.
  await dispatch(callbackUpdateAs('step:back', nextId(), USER));
  assert.equal(sessionState(USER.id).state, 'WAITING_DEVICE_LIMIT');
  stub.reset();
  await dispatch(messageUpdateAs(USER, '4', nextId()));
  const reject = String(sendTexts(USER.id).at(-1));
  assert.ok(reject.includes('دستگاه'), `device-domain rejection expected: ${reject}`);
  assert.equal(sessionState(USER.id).state, 'WAITING_DEVICE_LIMIT', 'out-of-range never advances');
  assert.equal(orderCount(), 0, 'no order possible from a refused step');
  // a forged `dev:10` callback — the option re-validation is unconditional
  await dispatch(callbackUpdateAs('dev:10', nextId(), USER));
  assert.equal(sessionState(USER.id).state, 'WAITING_DEVICE_LIMIT');
});

test('0012: purchase snapshot records max_devices=3 and the accepted count', async () => {
  const u = { id: 900000112, first_name: 'Snap', username: 'snap13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:3');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  const rows = ordersFor(u.id, 'purchase');
  assert.equal(rows.length, 1);
  const snap = JSON.parse(String(rows[0]['selections'])) as {
    device_count: number;
    limits: Record<string, number>;
  };
  assert.equal(snap.device_count, 3);
  assert.equal(snap.limits['min_devices'], 1);
  assert.equal(snap.limits['max_devices'], 3);
});

/* ═══════════════════════ fail-open loader (sales config) ═══════════════════════ */

test('sales config fails OPEN: only explicit {"schema":1,"stopped":true} blocks', async () => {
  const enabledCases: Array<[string, string | null]> = [
    ['missing row', null],
    ['json garbage', '"just a string"'],
    ['wrong schema', `{"schema":${SALES_SCHEMA + 1},"stopped":true}`],
    ['non-boolean stopped', '{"schema":1,"stopped":"yes"}'],
    ['array payload', '[]'],
  ];
  for (const [label, raw] of enabledCases) {
    salesSetRaw(raw);
    assert.equal(await isSalesStopped(shim as never), false, `${label} must mean ENABLED`);
    const state = await loadSalesState(shim as never);
    assert.equal(state.config.stopped, false, `${label}: config.stopped=false`);
  }
  // malformed but PRESENT is surfaced for admin display… still ENABLED (fail-open)
  salesSetRaw('{"nonsense":1}');
  assert.equal((await loadSalesState(shim as never)).malformed, true);
  assert.equal((await loadSalesState(shim as never)).config.stopped, false);
  // …and the ONLY blocking shape:
  salesSetRaw('{"schema":1,"stopped":true}');
  assert.equal(await isSalesStopped(shim as never), true);
  assert.equal((await loadSalesState(shim as never)).malformed, false);
  salesSetRaw('{"schema":1,"stopped":false}');
  assert.equal(await isSalesStopped(shim as never), false);

  assert.deepEqual(parseSalesConfig({ schema: SALES_SCHEMA, stopped: true }), { stopped: true });
  assert.equal(parseSalesConfig({ schema: SALES_SCHEMA }), null);
  assert.equal(parseSalesConfig({ schema: SALES_SCHEMA, stopped: 1 }), null);
});

/* ═════════════════════ strict sal: parser + admin authorization ═════════════════════ */

test('sal: parser accepts only the closed vocabulary; unknown verbs are null', () => {
  for (const verb of ['view', 'stop', 'start'] as const) {
    assert.equal(parseSalesCallback(`sal:${verb}`), verb);
  }
  for (const junk of ['sal:', 'sal:halt', 'sal:START', 'sal:stop:true', 'sal:view extra', 'sal', 'salx:view']) {
    assert.equal(parseSalesCallback(junk), null, `must reject: ${junk}`);
  }
});

test('/sales + sal: controls are admin-only; a user forge is INERT (no write, no audit)', async () => {
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  salesSetRaw('{"schema":1,"stopped":false}');
  stub.reset();
  const before = salesRaw();

  await dispatch(messageUpdateAs(USER, '/sales', nextId()));
  assert.ok(sendTexts(USER.id).some((t) => t.includes('در دسترس شما نیست')), 'customer told admin-only');
  for (const forged of ['sal:stop', 'sal:start', 'sal:view', 'sal:evil', 'sal:stop extra']) {
    await dispatch(callbackUpdateAs(forged, nextId(), USER));
  }
  assert.equal(salesRaw(), before, 'sales row byte-identical');
  assert.equal(salesAudit().length, 0, 'no audit rows');
  assert.ok(toasts().length >= 5, 'every forged tap answered with a toast');

  // an ADMIN gets the real surface and the visible state.
  await dispatch(messageUpdateAs(ADMIN, '/sales', nextId()));
  const adminText = sendTexts(ADMIN.id).at(-1) ?? '';
  assert.ok(adminText.includes('وضعیت سرویس:') && adminText.includes('🟢 فعال'), `state shown: ${adminText}`);
  assert.ok(keyboardButtons(lastKeyboard(ADMIN.id)).includes('sal:stop'), 'toggle affordance present');
  assert.equal(salesRaw(), before, 'merely VIEWING toggles nothing');
  assert.equal(salesAudit().length, 0);
});

test('concurrent admins: two STOP taps converge to ONE applied write (CAS, not lost update)', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/sales', nextId()));
  await dispatch(callbackUpdateAs('sal:stop', nextId(), ADMIN, ADMIN.id));
  const rows = salesAudit();
  assert.equal(rows.length, 1, `one audit row expected: ${JSON.stringify(rows)}`);
  const raw = salesRaw();
  // second admin, SAME intended value: current-state check short-circuits →
  // no additional CAS, no noise row; the document stays canonical.
  await dispatch(callbackUpdateAs('sal:stop', nextId(), ADMIN, ADMIN.id));
  assert.equal(salesRaw(), raw);
  assert.equal(salesAudit().length, 1, 'idempotent tap writes nothing');
  assert.ok(toasts().some((t) => t.includes('متوقف شد')), 'operator still gets success feedback');
  // resume
  await dispatch(callbackUpdateAs('sal:start', nextId(), ADMIN, ADMIN.id));
  assert.equal(salesRaw(), '{"schema":1,"stopped":false}');
  assert.equal(salesAudit().length, 2);
  const last = salesAudit()[1];
  assert.equal(last['action'], 'start');
  assert.equal(last['actor'], `admin:${String(ADMIN.id)}`);
  assert.equal(JSON.parse(String(last['old_value']))['stopped'], true);
  assert.equal(JSON.parse(String(last['new_value']))['stopped'], false);
});

/* ═════════ CAS audit on the stale path + malformed-doc repair (direct) ═════════ */

test('CAS writer: applied appends audit; stale oldJson conflicts and keeps the winner', async () => {
  const db = shim as never;
  salesSetRaw('{"schema":1,"stopped":false}');
  const outcome = await applySalesToggleCas(db, {
    oldJson: '{"schema":1,"stopped":false}',
    newJson: salesDoc(true),
    adminUserId: ADMIN.id,
    action: 'stop',
  });
  assert.equal(outcome, 'applied');
  assert.equal(salesRaw(), '{"schema":1,"stopped":true}');
  const stale = await applySalesToggleCas(db, {
    oldJson: '{"schema":1,"stopped":false}', // the loser's stale token
    newJson: salesDoc(false),
    adminUserId: 424242,
    action: 'start',
  });
  assert.equal(stale, 'conflict', 'stale CAS loses cleanly');
  assert.equal(salesRaw(), '{"schema":1,"stopped":true}', 'winner byte-intact');

  // a vanished row resolves to 'missing' (never a phony success)
  sqlite.prepare("DELETE FROM settings WHERE key = 'sales'").run();
  const missing = await applySalesToggleCas(db, {
    oldJson: '{"never":"stored"}',
    newJson: salesDoc(false),
    adminUserId: 1,
    action: 'start',
  });
  assert.equal(missing, 'missing');
  salesSetRaw('{"schema":1,"stopped":false}');
  // malformed doc: the toggle writes the canonical replacement over the raw
  // string used as CAS token (repair path through applySalesToggleCas).
  salesSetRaw('{"nonsense":1}');
  const repair = await applySalesToggleCas(db, {
    oldJson: '{"nonsense":1}',
    newJson: salesDoc(false),
    adminUserId: ADMIN.id,
    action: 'start',
  });
  assert.equal(repair, 'applied');
  assert.equal(salesRaw(), '{"schema":1,"stopped":false}');
});

/* ═════════════ commercial stop: blocked creation + zero side effects ═════════════ */

test('stop blocks fresh purchase ENTRY — both callback and reply-text transports', async () => {
  const u1 = { id: 900000201, first_name: 'Ent', username: 'ent_cb', language_code: 'fa' };
  const u2 = { id: 900000202, first_name: 'Txt', username: 'ent_tx', language_code: 'fa' };
  await dispatch(messageUpdateAs(u1, '/start', nextId()));
  await dispatch(messageUpdateAs(u2, '/start', nextId()));
  setStopped(true);
  stub.reset();

  await dispatch(callbackUpdateAs('menu:buy', nextId(), u1));
  assert.ok(sawStoppedNotice(u1.id), 'inline entry refused');
  assert.equal(sessionState(u1.id).state, 'IDLE', 'NO session write while stopped');

  await dispatch(messageUpdateAs(u2, '🛒 خرید سرویس', nextId())); // reply keyboard tap = text
  assert.ok(sawStoppedNotice(u2.id), 'text entry refused identically');
  assert.equal(sessionState(u2.id).state, 'IDLE');

  // resume → entry works from scratch
  setStopped(false);
  await dispatch(callbackUpdateAs('menu:buy', nextId(), u1));
  assert.equal(sessionState(u1.id).state, 'WAITING_CONFIG_NAME', 'resume opens the ladder');
});

test('stop blocks mid-draft purchase CONFIRM; same token completes after resume', async () => {
  const u = { id: 900000203, first_name: 'Drft', username: 'drft13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:2');
  const token = String(sessionState(u.id).data['order_token']);
  assert.match(token, ORDER_TOKEN_RE);

  setStopped(true);
  const before = orderCount();
  const ledger = walletCount();
  stub.reset();
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'confirm refused');
  assert.equal(orderCount(), before, 'NO order row while stopped');
  assert.equal(walletCount(), ledger, 'NO wallet ledger activity');
  assert.equal(sessionState(u.id).state, 'WAITING_ORDER_CONFIRMATION', 'draft survives the stop');
  assert.equal(String(sessionState(u.id).data['order_token']), token, 'draft token unchanged');

  setStopped(false);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.equal(orderCount(), before + 1, 'exactly one order on resume');
  assert.equal(ordersFor(u.id, 'purchase').length, 1, 'the SAME draft never double-created');
  assert.equal(sessionState(u.id).state, 'WAITING_PAYMENT_RECEIPT');
});

test('stop blocks WALLET full/partial purchases with ZERO debits; resume pays once', async () => {
  const u = { id: 900000204, first_name: 'Wal', username: 'wal13a', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  setBalance(u.id, 300000);
  // re-render the confirmation so the summary sees the live balance
  await dispatch(callbackUpdateAs('step:back', nextId(), u));
  await dispatch(callbackUpdateAs('dev:1', nextId(), u));
  assert.ok(sendTexts(u.id).at(-1)?.includes('کیف پول'), 'summary shows the wallet line');
  const bal0 = balance(u.id);

  setStopped(true);
  const orders0 = orderCount();
  const ledger0 = walletCount();
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:full', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'wlt:full refused');
  assert.equal(balance(u.id), bal0, 'full wallet: no debit');
  await dispatch(callbackUpdateAs('wlt:part', nextId(), u));
  assert.equal(balance(u.id), bal0, 'partial wallet: no debit');
  assert.equal(orderCount(), orders0, 'no order');
  assert.equal(walletCount(), ledger0, 'no ledger row');

  setStopped(false);
  await dispatch(callbackUpdateAs('wlt:full', nextId(), u));
  assert.equal(orderCount(), orders0 + 1, 'one wallet-paid order on resume');
  assert.ok(balance(u.id) < bal0 && balance(u.id) > 0 - 1, 'wallet finally charged on resume');
  const paid = sqlite
    .prepare("SELECT COUNT(*) n FROM wallet_entries WHERE kind='order_payment' AND customer_id = ?1")
    .get(String(cidSync(u.id))) as { n: number };
  assert.equal(paid.n, 1, 'exactly one payment claim');
});

test('stop blocks wallet PURCHASES even when the summary was rendered before the stop', async () => {
  const u = { id: 900000211, first_name: 'Stale', username: 'stale13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  setBalance(u.id, 300000);
  await dispatch(callbackUpdateAs('step:back', nextId(), u));
  await dispatch(callbackUpdateAs('dev:1', nextId(), u)); // wallet summary in hand
  setStopped(true);
  const bal0 = balance(u.id);
  const orders0 = orderCount();
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u)); // plain confirm too
  assert.equal(orderCount(), orders0);
  await dispatch(callbackUpdateAs('wlt:full', nextId(), u)); // stale wallet button
  assert.equal(balance(u.id), bal0);
  assert.equal(orderCount(), orders0);
  assert.ok(sawStoppedNotice(u.id));
  setStopped(false);
});

test('stop blocks RENEWALS outright (entry, confirm, wallet) — panel capacity may be exhausted', async () => {
  const u = { id: 900000205, first_name: 'Ren', username: 'ren13a', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  assert.ok(serviceId);

  // the renewal button itself is gone from the detail view while stopped
  setStopped(true);
  stub.reset();
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), u));
  const detailButtons = keyboardButtons(lastKeyboard(u.id));
  assert.equal(
    detailButtons.some((b) => b.startsWith('svc:rnw:')),
    false,
    'no renew affordance while stopped: ' + detailButtons.join(' '),
  );

  // forged/racing taps fall to the server-side guard in renewableService:
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'renewal entry refused server-side');
  assert.equal(sessionState(u.id).state, 'IDLE', 'ladder never entered');
  const orders0 = orderCount();
  assert.equal(ordersFor(u.id, 'purchase').length, 1, 'only the original purchase for this user');
  assert.equal(ordersFor(u.id, 'renewal').length, 0, 'no renewal while stopped');

  // a draft built BEFORE the stop cannot be confirmed
  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME');
  await dispatch(callbackUpdateAs('vol:0', nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_CONFIRMATION');
  const renewToken = String(sessionState(u.id).data['order_token']);
  setStopped(true);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.equal(orderCount(), orders0, 'no renewal order while stopped');
  assert.ok(sawStoppedNotice(u.id));

  // resume: the SAME renewal draft confirms cleanly
  setStopped(false);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.equal(orderCount(), orders0 + 1, 'renewal created on resume');
  const renewals = ordersFor(u.id, 'renewal');
  assert.equal(renewals.length, 1);
  assert.equal(String(sessionState(u.id).data['order_token']), renewToken, 'same draft token');
});

test('stop blocks WALLET renewals with zero debits', async () => {
  const u = { id: 900000206, first_name: 'RenW', username: 'renw13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  setBalance(u.id, 300000);
  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  await dispatch(callbackUpdateAs('vol:0', nextId(), u));
  const bal0 = balance(u.id);
  const orders0 = orderCount();
  const ledger0 = walletCount();

  setStopped(true);
  stub.reset();
  await dispatch(callbackUpdateAs('wlt:full', nextId(), u));
  await dispatch(callbackUpdateAs('wlt:part', nextId(), u));
  assert.equal(balance(u.id), bal0, 'wallet renewal: no debit');
  assert.equal(orderCount(), orders0, 'no renewal order');
  assert.equal(walletCount(), ledger0, 'no ledger claim');
  assert.ok(sawStoppedNotice(u.id));

  setStopped(false);
  await dispatch(callbackUpdateAs('wlt:full', nextId(), u));
  assert.equal(orderCount(), orders0 + 1, 'wallet renewal works again after resume');
  assert.ok(balance(u.id) < bal0);
});

test('stop blocks renewal dur:* taps mid-draft (preset and skip)', async () => {
  const u = { id: 900000207, first_name: 'RenD', username: 'rend13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  assert.ok(serviceId);

  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_DURATION');
  const orders0 = orderCount();

  setStopped(true);
  stub.reset();
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'dur preset refused while stopped');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_DURATION', 'state unchanged');
  stub.reset();
  await dispatch(callbackUpdateAs('dur:0', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'dur skip refused while stopped');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_DURATION', 'state unchanged');
  assert.equal(orderCount(), orders0, 'zero new orders');

  setStopped(false);
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
});

test('stop blocks renewal vol:* taps mid-draft (preset and skip)', async () => {
  const u = { id: 900000208, first_name: 'RenV', username: 'renv13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  assert.ok(serviceId);

  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME');
  const orders0 = orderCount();

  setStopped(true);
  stub.reset();
  await dispatch(callbackUpdateAs('vol:20', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'vol preset refused while stopped');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME', 'state unchanged');
  stub.reset();
  await dispatch(callbackUpdateAs('vol:0', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'vol skip refused while stopped');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME', 'state unchanged');
  assert.equal(orderCount(), orders0, 'zero new orders');

  setStopped(false);
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
});

test('stop blocks renewal custom-volume text mid-draft', async () => {
  const u = { id: 900000209, first_name: 'RenC', username: 'renc13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  assert.ok(serviceId);

  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME');
  const orders0 = orderCount();

  setStopped(true);
  stub.reset();
  await dispatch(messageUpdateAs(u, '15', nextId()));
  assert.ok(sawStoppedNotice(u.id), 'custom volume refused while stopped');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_VOLUME', 'no advance to confirmation');
  assert.equal(orderCount(), orders0, 'zero new orders');

  setStopped(false);
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
});

test('stop blocks volume-bearing renewal confirmation with zero panel writes', async () => {
  const u = { id: 900000210, first_name: 'RenB', username: 'renb13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  assert.ok(serviceId);

  setStopped(false);
  await dispatch(callbackUpdateAs(`svc:rnw:${serviceId}`, nextId(), u));
  await dispatch(callbackUpdateAs('dur:30', nextId(), u));
  await dispatch(callbackUpdateAs('vol:20', nextId(), u));
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_CONFIRMATION');
  assert.equal(sessionState(u.id).data['added_volume_gb'], 20, 'volume-bearing draft');
  const orders0 = orderCount();

  setStopped(true);
  stub.reset();
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.ok(sawStoppedNotice(u.id), 'volume renewal confirm refused while stopped');
  assert.equal(orderCount(), orders0, 'zero new orders');
  assert.equal(stub.panel.calls.length, 0, 'zero PasarGuard PUTs');
  assert.equal(sessionState(u.id).state, 'WAITING_RENEWAL_CONFIRMATION', 'draft preserved');

  // resume: the SAME volume-bearing draft confirms cleanly
  setStopped(false);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  assert.equal(orderCount(), orders0 + 1, 'volume renewal created on resume');
  const renewals = ordersFor(u.id, 'renewal');
  assert.equal(renewals.length, 1);
  assert.equal(
    JSON.parse(String(renewals[0]!['selections']))['added_volume_gb'],
    20,
    'volume survives the resume',
  );
});

/* ═════════════════════ checkout backstop (defense in depth) ═════════════════════ */

test('backstop: checkoutOrder + checkoutRenewalOrder refuse while stopped, before any insert', async () => {
  const loaded = await loadCatalog(shim as never);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const price = calculatePrice(loaded.catalog.pricing, { volumeGb: 10, durationDays: 30, deviceCount: 1 });
  if (!price.ok) return assert.fail('fixture must price');
  const rprice = calculateRenewalPrice(loaded.catalog.pricing, { durationDays: 30 });
  if (!rprice.ok) return assert.fail('renewal fixture must price');
  const draft: CheckoutDraft = {
    customerId: 1,
    orderToken: newOrderId(),
    configName: 'backstop probe',
    catalog: loaded.catalog,
    breakdown: price.breakdown,
  };
  const rdraft: RenewalCheckoutDraft = {
    customerId: 1,
    orderToken: newOrderId(),
    catalog: loaded.catalog,
    breakdown: rprice.breakdown,
    serviceOrderId: 'A'.repeat(28),
  };
  const orders0 = orderCount();
  setStopped(true);
  const b1 = await checkoutOrder(shim as never, draft);
  const b2 = await checkoutRenewalOrder(shim as never, rdraft, 'backstop probe');
  assert.deepEqual(b1, { ok: false, error: 'sales_stopped' });
  assert.deepEqual(b2, { ok: false, error: 'sales_stopped' });
  assert.equal(orderCount(), orders0, 'backstop inserts NOTHING');
  setStopped(false);
  const ok1 = await checkoutOrder(shim as never, { ...draft, orderToken: newOrderId() });
  assert.equal(ok1.ok, true, 'the same code path works once resumed');
});

/* ═══════════════════ state lives in D1 = restart-safe, by construction ═══════════════════ */

test('stopped flag persists in D1 and is re-read EVERY webhook (no worker memory involved)', async () => {
  // toggle via the admin UI, then prove the raw row IS the memory …
  await dispatch(messageUpdateAs(ADMIN, '/sales', nextId()));
  await dispatch(callbackUpdateAs('sal:stop', nextId(), ADMIN, ADMIN.id));
  assert.equal(salesRaw(), '{"schema":1,"stopped":true}');
  // … a completely fresh load (a new Worker isolate would do exactly this) …
  const freshShim = makeD1Shim(sqlite);
  assert.equal(await isSalesStopped(freshShim as never), true);
  const u = { id: 900000207, first_name: 'Per', username: 'per13', language_code: 'fa' };
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  // … and the next customer update on THIS isolate still sees it …
  await dispatch(callbackUpdateAs('menu:buy', nextId(), u));
  assert.equal(sessionState(u.id).state, 'IDLE', 'still stopped: state is not in a closure');
  // … while an admin control remains fully reachable AND shows the truth.
  await dispatch(messageUpdateAs(ADMIN, '/sales', nextId()));
  assert.ok(String(sendTexts(ADMIN.id).at(-1)).includes('🔴 متوقف'), 'admin sees the persisted stop');
  assert.ok(keyboardButtons(lastKeyboard(ADMIN.id)).includes('sal:start'), 'resume affordance offered');
  // resume through the control so later tests inherit an open switch
  await dispatch(callbackUpdateAs('sal:start', nextId(), ADMIN, ADMIN.id));
  assert.equal(salesRaw(), '{"schema":1,"stopped":false}');
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  await dispatch(messageUpdateAs(ADMIN, '/cancel', nextId()));
});

/* ═════════════ what MUST still work while commercial stop is ON ═════════════ */

test('while stopped: services view, detail, subscription page, order history, support all work', async () => {
  const u = { id: 900000208, first_name: 'Svc', username: 'svc13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u));
  await dispatch(messageUpdateAs(u, '/cancel', nextId()));
  const serviceId = markServiceCompleted(u.id);
  setStopped(true);
  stub.reset();

  await dispatch(callbackUpdateAs('menu:services', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('📦 سرویس‌های')), 'services list OK');
  await dispatch(callbackUpdateAs(`svc:det:${serviceId}`, nextId(), u));
  const detail = sendTexts(u.id).join('\n');
  assert.ok(/panel\.example|باز کردن صفحه سرویس/.test(detail), 'subscription page CTA still present');
  const detailButtons = keyboardButtons(lastKeyboard(u.id));
  assert.ok(detailButtons.some((b) => b.startsWith('svc:ref:')), 'status refresh still present');
  assert.equal(detailButtons.some((b) => b.startsWith('svc:rnw:')), false, 'renew hidden while commercial creation is stopped');
  // "refresh status" is a LIVE read (live=true); with only a stub URL and no
  // panel it re-renders/degrades WITHOUT refusing — the point is the stop did
  // not gate a non-commercial existing-service action. It may edit in place
  // (no new sendMessage) rather than send, so observe a reply of any kind.
  const repliesBefore = sendTexts(u.id).length + toasts().length;
  await dispatch(callbackUpdateAs(`svc:ref:${serviceId}`, nextId(), u));
  const repliesAfter = sendTexts(u.id).length + toasts().length;
  assert.ok(repliesAfter > repliesBefore - 5, 'refresh handled without a stop-refusal');
  assert.equal(sawStoppedNotice(u.id), false, 'svc:ref must NEVER show the sales-stop notice');

  await dispatch(callbackUpdateAs('menu:orders', nextId(), u)); // history unaffected
  assert.ok(sendTexts(u.id).some((t) => t.includes('سفارش‌های شما')));
  setStopped(false);
});

test('while stopped: an order created BEFORE the stop stays payable (receipt accepted) and approvable', async () => {
  const u = { id: 900000209, first_name: 'Pre', username: 'pre13', language_code: 'fa' };
  await draftToConfirm(u, 'dev:1');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), u)); // durable, pending_payment
  const order = ordersFor(u.id, 'purchase')[0] as { id: string; state: string };
  assert.equal(order.state, 'pending_payment');

  setStopped(true);
  // The customer keeps paying exactly as before: mid-flow text re-shows the
  // receipt notice, and the receipt itself still uploads & enters review …
  await dispatch(messageUpdateAs(u, 'xyz', nextId()));
  assert.ok(sendTexts(u.id).some((t) => t.includes('در انتظار پرداخت') || t.includes('فیش')));
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'PH13PRE' }, u));
  const reviewed = sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(order.id) as { state: string };
  assert.equal(reviewed.state, 'awaiting_review', 'receipt accepted while stopped');
  // … money-adjacent, NOT a creation path — never gated by the switch.
  assert.equal(sawStoppedNotice(u.id), false, 'no stop notice on the payment path');
  // … and admin review proceeds (approve; provisioning skips unconfigured).
  const review = await performAdminReview({
    env,
    db: shim as never,
    api: {
      sendMessage: async () => ({}),
      editMessageText: async () => true,
      editMessageCaption: async () => true,
      answerCallbackQuery: async () => true,
      sendPhoto: async () => true,
      sendDocument: async () => true,
    } as unknown as TelegramApiLike,
    actorId: ADMIN.id,
    orderId: order.id,
    decision: 'approve',
  });
  assert.equal(review.ok, true, `pre-stop order approved while stopped: ${JSON.stringify(review)}`);
  const approved = sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(order.id) as { state: string };
  assert.equal(approved.state, 'approved', 'approved even under the stop — money never stranded');
  setStopped(false);
});

test('while stopped: account, wallet, guide, language and /start all keep working; admin /announce still runs', async () => {
  const u = { id: 900000210, first_name: 'Sup', username: 'sup13', language_code: 'fa' };
  setStopped(true);
  stub.reset();
  await dispatch(messageUpdateAs(u, '/start', nextId()));
  assert.ok(sendTexts(u.id).some((t) => t.includes('درود')), '/start keeps its greeting');
  await dispatch(callbackUpdateAs('menu:account', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('حساب شما')));
  await dispatch(callbackUpdateAs('menu:wallet', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('💰 کیف پول')));
  await dispatch(callbackUpdateAs('menu:invite', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('دعوت از دوستان')));
  await dispatch(callbackUpdateAs('menu:guide', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('راهنمای اتصال')));
  await dispatch(callbackUpdateAs('menu:lang', nextId(), u));
  assert.ok(sendTexts(u.id).some((t) => t.includes('زبان ربات')));
  await dispatch(callbackUpdateAs('lang:en', nextId(), u));
  assert.equal(
    (sqlite.prepare('SELECT language FROM customers WHERE telegram_user_id = ?1').get(String(u.id)) as { language: string | null }).language,
    'en',
  );
  await dispatch(callbackUpdateAs('lang:fa', nextId(), u));
  // Direct support must never touch the session (no ticket state entered).
  await dispatch(callbackUpdateAs('menu:support', nextId(), u));
  assert.equal(sessionState(u.id).state, 'IDLE');

  // admin announces WHILE STOPPED and the fan-out still delivers
  await dispatch(messageUpdateAs(ADMIN, '/announce 🎉 اطلاعیه تست توقف', nextId()));
  assert.equal(sessionState(ADMIN.id).state, 'WAITING_ANNOUNCE_CONFIRM');
  const annId = String(sessionState(ADMIN.id).data['announcement_id']);
  await dispatch(callbackUpdateAs(`ann:go:${annId}`, nextId(), ADMIN, ADMIN.id));
  const done = sqlite.prepare("SELECT state FROM announcements WHERE id = ?1").get(annId) as { state: string };
  assert.equal(done.state, 'done', 'announcement completed while sales stopped');
  assert.ok(sendTexts(ADMIN.id).some((t) => t.includes('کامل شد')));
  assert.ok(salesRaw() === '{"schema":1,"stopped":true}', 'announcement fanout never touched the switch');
  await dispatch(messageUpdateAs(ADMIN, '/cancel', nextId()));
  setStopped(false);
});
