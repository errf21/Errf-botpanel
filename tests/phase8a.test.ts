/**
 * Phase 8A e2e: the main menu is a REAL Telegram Reply Keyboard.
 * Fully offline (D1 shim over migrations 0001-0010 + fetch stub).
 * Covers: keyboard shape (rows, labels, styles — exactly three styled, the
 * rest basic; Phase 10 adds the locale-fixed language selector button →
 * 8 labels in 4 rows of two), text→action routing for all seven shortcuts at IDLE, callback
 * parity, the composing keyboards that replace the menu while free text is
 * awaited (config name, support draft, admin ticket reply, admin reject
 * skip), exact-match interception gates (back / auto-pick / menu labels ONLY
 * where the keyboard can actually show them), menu restoration at flow ends,
 * and unchanged stale-input behavior. The whole pre-8A suite keeping green
 * is the backward-compatibility proof.
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
} from './helpers.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const {
  MAIN_MENU_ENTRIES,
  STEP_AUTO_TEXT,
  STEP_BACK_TEXT,
  STEP_SKIP_REJECT_TEXT,
} = await import('../src/telegram/menu.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

let counter = 80000;
const nextId = () => ++counter;

const sends = () => stub.sendCalls();
const sentTo = (chatId: number) =>
  stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const sendsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage');
const textsTo = (chatId: number) => sendsTo(chatId).map((s) => String(s.text));

interface ReplyKeyboard {
  keyboard: Array<Array<{ text: string; style?: string }>>;
  resize_keyboard?: boolean;
  is_persistent?: boolean;
}

function replyKbOf(payload: Record<string, unknown>): ReplyKeyboard | undefined {
  const markup = payload['reply_markup'] as
    | (ReplyKeyboard & { inline_keyboard?: unknown })
    | undefined;
  if (!markup || markup.inline_keyboard !== undefined) return undefined;
  return Array.isArray(markup.keyboard) ? markup : undefined;
}

const MAIN_LABELS = [
  '🛒 خرید سرویس',
  '📦 سرویس‌های من',
  '💳 سفارش‌های من',
  '👤 حساب کاربری',
  '💰 کیف پول',
  '🤝 دعوت از دوستان',
  '🆘 پشتیبانی',
  // Phase 11: the connection guide — before the language button.
  '📚 راهنمای اتصال',
  // Phase 10: the language selector — one locale-FIXED bilingual button.
  '🌐 زبان / Language',
];

function sessionFor(tgUserId: number): string {
  const row = sqlite
    .prepare(
      `SELECT s.state FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgUserId)) as { state: string } | undefined;
  return row?.state ?? 'IDLE';
}

function sessionData(tgUserId: number): Record<string, unknown> {
  const row = sqlite
    .prepare(
      `SELECT s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgUserId)) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Record<string, unknown>) : {};
}

function ticketMessageCount(): number {
  return Number(
    sqlite.prepare('SELECT COUNT(*) AS n FROM support_messages').get()['n'],
  );
}

function hasMainLabel(kb: ReplyKeyboard | undefined, label: string): boolean {
  return (kb?.keyboard ?? []).flat().some((b) => b.text === label);
}

// ————————————————————— keyboard shape —————————————————————

test('/start presents a Reply Keyboard: 9 labels in 5 rows (2/2/2/2/1), RTL pairing', async () => {
  const hero = { ...USER, id: 810000001, username: 'p8a_shape' };
  stub.reset();
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const kb = replyKbOf(sends()[0]!.payload);
  assert.ok(kb, 'reply keyboard expected on the welcome message');
  assert.equal(kb!.resize_keyboard, true);
  assert.equal(kb!.is_persistent, true);
  assert.deepEqual(
    kb!.keyboard.map((r) => r.length),
    [2, 2, 2, 2, 1],
  );
  assert.deepEqual(
    kb!.keyboard.flat().map((b) => b.text),
    MAIN_LABELS,
  );
});

test('exactly three buttons carry Telegram styles; the rest ship no style field', async () => {
  const styled = MAIN_MENU_ENTRIES.filter((e) => e.style !== undefined);
  assert.equal(styled.length, 3);
  assert.deepEqual(
    styled.map((e) => [e.label, e.style]),
    [
      ['🛒 خرید سرویس', 'primary'],
      ['📦 سرویس‌های من', 'primary'],
      ['💰 کیف پول', 'success'],
    ],
  );

  // Wire-level proof: emitted buttons have NO `style` key except the three.
  const hero = { ...USER, id: 810000002, username: 'p8a_shape2' };
  stub.reset();
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const buttons = (replyKbOf(sends()[0]!.payload)?.keyboard ?? []).flat();
  const withStyle = buttons.filter((b) => Object.prototype.hasOwnProperty.call(b, 'style'));
  assert.equal(withStyle.length, 3);
  assert.deepEqual(
    Object.fromEntries(withStyle.map((b) => [b.text, b.style])),
    {
      '🛒 خرید سرویس': 'primary',
      '📦 سرویس‌های من': 'primary',
      '💰 کیف پول': 'success',
    },
  );
});

// ————————————————————— text→action routing —————————————————————

test('every menu label sent as text triggers its existing action from IDLE', async () => {
  const cases: Array<{ label: string; stateAfter: string; textMust: string }> = [
    { label: '🛒 خرید سرویس', stateAfter: 'WAITING_CONFIG_NAME', textMust: 'نام' },
    { label: '📦 سرویس‌های من', stateAfter: 'IDLE', textMust: 'سرویس فعالی ندارید' },
    { label: '💳 سفارش‌های من', stateAfter: 'IDLE', textMust: 'سفارشی ثبت نکرده‌اید' },
    { label: '👤 حساب کاربری', stateAfter: 'IDLE', textMust: '👤 اطلاعات حساب شما' },
    { label: '💰 کیف پول', stateAfter: 'IDLE', textMust: 'کیف پول' },
    { label: '🤝 دعوت از دوستان', stateAfter: 'IDLE', textMust: 'دعوت از دوستان' },
    { label: '🆘 پشتیبانی', stateAfter: 'WAITING_SUPPORT_MESSAGE', textMust: 'پشتیبانی' },
    // Phase 11: the guide runs WITHOUT session involvement — IDLE stays IDLE.
    { label: '📚 راهنمای اتصال', stateAfter: 'IDLE', textMust: 'سه قدم کوتاه' },
  ];
  let index = 0;
  for (const scenario of cases) {
    index += 1;
    const hero = { ...USER, id: 811000000 + index, username: 'p8a_sc' + index };
    await dispatch(messageUpdateAs(hero, '/start', nextId()));
    stub.reset();
    await dispatch(messageUpdateAs(hero, scenario.label, nextId()));
    const texts = textsTo(hero.id);
    assert.ok(
      texts.some((t) => t.includes(scenario.textMust)),
      `label "${scenario.label}" must run its action; saw: ${texts.join(' | ')}`,
    );
    assert.equal(sessionFor(hero.id), scenario.stateAfter, `state after "${scenario.label}"`);
  }
});

test('keyboard-text tap and legacy callback tap render identical output', async () => {
  const viaCb = { ...USER, id: 812000001, username: 'p8a_cb' };
  const viaText = { ...USER, id: 812000002, username: 'p8a_tx' };
  await dispatch(messageUpdateAs(viaCb, '/start', nextId()));
  await dispatch(messageUpdateAs(viaText, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('menu:wallet', nextId(), viaCb));
  const cbTexts = textsTo(viaCb.id);
  stub.reset();
  await dispatch(messageUpdateAs(viaText, '💰 کیف پول', nextId()));
  const txTexts = textsTo(viaText.id);
  assert.equal(cbTexts.length > 0, true);
  assert.deepEqual(txTexts, cbTexts);
});

// ————————————————————— composing mode & restoration —————————————————————

test('buy from keyboard hides the main menu behind [auto-pick][back]', async () => {
  const hero = { ...USER, id: 813000001, username: 'p8a_buy' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, '🛒 خرید سرویس', nextId()));
  assert.equal(sessionFor(hero.id), 'WAITING_CONFIG_NAME');
  const kb = replyKbOf(sendsTo(hero.id).at(-1)!.payload);
  assert.ok(kb, 'composing keyboard on the intro');
  assert.deepEqual(kb!.keyboard.flat().map((b) => b.text), [STEP_AUTO_TEXT, STEP_BACK_TEXT]);
  assert.equal(
    kb!.keyboard.flat().some((b) => MAIN_LABELS.includes(b.text)),
    false,
    'main menu labels gone while free text is expected',
  );
});

test('menu labels typed during WAITING_CONFIG_NAME are name input, never menu actions', async () => {
  const hero = { ...USER, id: 813000002, username: 'p8a_namecollide' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(messageUpdateAs(hero, '🛒 خرید سرویس', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, '💰 کیف پول', nextId()));
  assert.equal(sessionFor(hero.id), 'WAITING_CONFIG_NAME', 'purchase preserved');
  assert.ok(textsTo(hero.id).some((t) => t.includes('نامعتبر')), 'rejected as a name');
});

test('auto-pick text advances ONLY from the name step; numeric steps reject it as input', async () => {
  const hero = { ...USER, id: 813000003, username: 'p8a_auto' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(messageUpdateAs(hero, '🛒 خرید سرویس', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, STEP_AUTO_TEXT, nextId()));
  assert.equal(sessionFor(hero.id), 'WAITING_VOLUME');
  assert.match(
    String(sessionData(hero.id)['config_name']),
    /^[A-Z][a-z]{3,11} [A-Z][a-z]{3,11} [A-Z][a-z]{3,11}$/,
  );
  // the same text one step later lands in the numeric handler (still text!)
  stub.reset();
  await dispatch(messageUpdateAs(hero, STEP_AUTO_TEXT, nextId()));
  assert.equal(sessionFor(hero.id), 'WAITING_VOLUME', 'state kept');
  assert.ok(textsTo(hero.id).some((t) => t.includes('صحیح')), 'numeric rejection shown');
});

test('support composing hides the menu; submit restores it; back aborts instead of posting', async () => {
  const hero = { ...USER, id: 813000004, username: 'p8a_support' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(messageUpdateAs(hero, '🆘 پشتیبانی', nextId()));
  assert.equal(sessionFor(hero.id), 'WAITING_SUPPORT_MESSAGE');
  assert.deepEqual(
    replyKbOf(sendsTo(hero.id).at(-1)!.payload)!.keyboard.flat().map((b) => b.text),
    [STEP_BACK_TEXT],
  );

  stub.reset();
  await dispatch(messageUpdateAs(hero, 'سرویس من از صبح قطع است، لطفا بررسی کنید', nextId()));
  assert.equal(sessionFor(hero.id), 'IDLE', 'ticket ladder exits to IDLE');
  assert.ok(
    hasMainLabel(replyKbOf(sendsTo(hero.id).at(-1)!.payload), '🛒 خرید سرویس'),
    'menu restored after submit',
  );

  // back DURING composing aborts — it never becomes the ticket body
  const fresh = { ...USER, id: 813000006, username: 'p8a_support_abort' };
  const before = ticketMessageCount();
  await dispatch(messageUpdateAs(fresh, '/start', nextId()));
  await dispatch(messageUpdateAs(fresh, '🆘 پشتیبانی', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(fresh, STEP_BACK_TEXT, nextId()));
  assert.equal(sessionFor(fresh.id), 'IDLE');
  assert.equal(ticketMessageCount(), before, 'back created no ticket');
  assert.ok(textsTo(fresh.id).some((t) => t.includes('به منوی اصلی بازگشتید')));
  assert.ok(
    hasMainLabel(replyKbOf(sendsTo(fresh.id).at(-1)!.payload), '💳 سفارش‌های من'),
    'menu back at the bottom',
  );
});

test('back text from IDLE re-presents the menu without touching state', async () => {
  const hero = { ...USER, id: 813000005, username: 'p8a_backidle' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, STEP_BACK_TEXT, nextId()));
  assert.equal(sessionFor(hero.id), 'IDLE');
  assert.equal(sendsTo(hero.id).length, 1, 'a single hint message');
  assert.ok(
    hasMainLabel(replyKbOf(sendsTo(hero.id).at(-1)!.payload), '🛒 خرید سرویس'),
  );
});

// ————————————————————— admin composing arming —————————————————————

test('admin ticket-reply arming hides the menu; a menu label is not the reply', async () => {
  const customer = { ...USER, id: 814000001, username: 'p8a_cust' };
  await dispatch(messageUpdateAs(customer, '/start', nextId()));
  await dispatch(messageUpdateAs(customer, '🆘 پشتیبانی', nextId()));
  await dispatch(messageUpdateAs(customer, 'درخواست بررسی قطع سرویس', nextId()));
  const ticket = sqlite.prepare('SELECT id FROM support_tickets LIMIT 1').get() as
    | { id: string }
    | undefined;
  assert.ok(ticket?.id);
  const msgsBefore = ticketMessageCount();

  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:rp:${ticket!.id}`, nextId(), ADMIN));
  const prompt = sends().at(-1)!;
  assert.ok(String(prompt.text).includes('پاسخ خود را'));
  assert.deepEqual(
    replyKbOf(prompt.payload)?.keyboard.flat().map((b) => b.text),
    [STEP_BACK_TEXT],
  );

  // menu label while armed → the view runs, arming survives, no ticket reply
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '👤 حساب کاربری', nextId()));
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('👤 اطلاعات حساب')));
  assert.equal(ticketMessageCount(), msgsBefore, 'reply NOT consumed as ticket body');
  assert.ok(
    sqlite
      .prepare(
        "SELECT * FROM admin_actions WHERE admin_user_id = ?1 AND action = 'support_reply'",
      )
      .get(String(ADMIN.id)),
    'still armed after a menu tap',
  );

  // back clears the arming and restores the main keyboard
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, STEP_BACK_TEXT, nextId()));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()['n'], 0);
  assert.ok(textsTo(ADMIN.id).some((t) => t.includes('لغو شد')));
  assert.ok(hasMainLabel(replyKbOf(sendsTo(ADMIN.id).at(-1)!.payload), '🛒 خرید سرویس'));
});

test('admin reject arming uses the composing keyboard; reason text still applies', async () => {
  const hero = { ...USER, id: 814000002, username: 'p8a_rej' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), hero));
  await dispatch(messageUpdateAs(hero, 'north valley signal', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), hero));
  await dispatch(callbackUpdateAs('dur:30', nextId(), hero));
  await dispatch(callbackUpdateAs('dev:3', nextId(), hero));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), hero));
  const orderId = String(sessionData(hero.id)['order_id']);
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'P8A_SHOT' }, hero));
  assert.equal(
    (sqlite.prepare('SELECT state FROM orders WHERE id = ?1').get(orderId) as { state: string })
      .state,
    'awaiting_review',
  );

  stub.reset();
  await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN));
  const prompt = sends().find((s) => String(s.text).includes('دلیل رد'))!;
  assert.ok(prompt, 'reject prompt sent');
  assert.deepEqual(
    replyKbOf(prompt.payload)?.keyboard.flat().map((b) => b.text),
    [STEP_SKIP_REJECT_TEXT, STEP_BACK_TEXT],
  );

  // plain reason text (not a control label) is consumed exactly as before
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, 'مبلغ واریزی با فیش نمی‌خواند', nextId()));
  assert.equal(
    (sqlite.prepare('SELECT state, failure_reason FROM orders WHERE id = ?1').get(orderId) as {
      state: string;
      failure_reason: string;
    }).state,
    'rejected',
  );
});

test('skip text applies the default reason ONLY while a reject is armed', async () => {
  // no pending arming (IDLE, no admin action row) → skip text is inert chatter
  const hero = { ...USER, id: 814000003, username: 'p8a_skip' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, STEP_SKIP_REJECT_TEXT, nextId()));
  assert.equal(sessionFor(hero.id), 'IDLE');
  assert.equal(sendsTo(hero.id).length, 1, 'idle hint only');

  const orderId = await orderInReview();
  assert.ok(orderId);
  stub.reset();
  await dispatch(callbackUpdateAs(`adm:no:${orderId}`, nextId(), ADMIN));
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, STEP_SKIP_REJECT_TEXT, nextId()));
  assert.equal(
    (sqlite.prepare('SELECT state, failure_reason FROM orders WHERE id = ?1').get(orderId) as {
      state: string;
      failure_reason: string;
    }).failure_reason,
    'پرداخت تأیید نشد.',
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()['n'],
    0,
    'arming consumed',
  );
});

async function orderInReview(): Promise<string> {
  const hero = { ...USER, id: 814000004, username: 'p8a_rej2' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), hero));
  await dispatch(messageUpdateAs(hero, 'quiet harbor relay', nextId()));
  await dispatch(callbackUpdateAs('vol:10', nextId(), hero));
  await dispatch(callbackUpdateAs('dur:30', nextId(), hero));
  await dispatch(callbackUpdateAs('dev:3', nextId(), hero));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), hero));
  const orderId = String(sessionData(hero.id)['order_id']);
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: 'P8A_SHOT2' }, hero));
  return orderId;
}

// ————————————————————— regression: the old inline world stays alive —————————————————————

test('legacy inline act:back_menu tap edits the bubble and clears its buttons', async () => {
  const hero = { ...USER, id: 815000001, username: 'p8a_legacy' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs('act:back_menu', nextId(), hero));
  const edit = stub.sent.find((s) => s.method === 'editMessageText');
  assert.ok(edit, 'legacy tap still edits the tapped bubble');
  const markup = edit!.payload['reply_markup'] as { inline_keyboard: unknown[] };
  assert.deepEqual(markup.inline_keyboard, [], 'old inline buttons removed on the menu switch');
});

test('unknown free text stays unknown and re-presents the keyboard', async () => {
  const hero = { ...USER, id: 815000002, username: 'p8a_junk' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'سلام دنیا، حالت چطوره؟', nextId()));
  assert.equal(sessionFor(hero.id), 'IDLE');
  const hint = sendsTo(hero.id).at(-1)!;
  assert.ok(String(hint.text).includes('منو'));
  assert.ok(hasMainLabel(replyKbOf(hint.payload), '🛒 خرید سرویس'));
});
