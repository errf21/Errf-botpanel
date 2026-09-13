/**
 * Phase 10 e2e: English as a first-class language.
 * Fully offline (D1 shim over 0001-0010 + fetch stub). Covers: the
 * NO-AUTO-DETECT default, selector → D1 persistence → keyboard re-render,
 * stale other-locale taps routing, a complete English purchase→payment→
 * receipt→review walk, English proactive notices and sweeps, and the
 * Persian-only admin surface — while all state/pricing behavior stays put.
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
const { fa } = await import('../src/telegram/texts.ts');
const { newOrderId } = await import('../src/lib/security.ts');
const { en } = await import('../src/telegram/texts.en.ts');

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

let counter = 95000;
const nextId = () => ++counter;

const PERSIAN = /[\u0600-\u06FF\u200C\u200D]/;
const sentTo = (chatId: number) =>
  stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const sendsTo = (chatId: number) => sentTo(chatId).filter((s) => s.method === 'sendMessage');
const textsTo = (chatId: number) => sendsTo(chatId).map((s) => String(s.text));
const lastBubble = (chatId: number) => sendsTo(chatId).at(-1)!;
const toastsTo = (chatId: number) =>
  sentTo(chatId)
    .filter((s) => s.method === 'answerCallbackQuery')
    .map((s) => String(s.payload['text'] ?? ''));

function replyKbOf(payload: Record<string, unknown>) {
  const markup = payload['reply_markup'] as
    | { keyboard?: Array<Array<{ text: string; style?: string }>> }
    | undefined;
  return markup && Array.isArray(markup.keyboard) ? markup : undefined;
}
function inlineKbOf(payload: Record<string, unknown>) {
  const markup = payload['reply_markup'] as
    | { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string; url?: string }>> }
    | undefined;
  return markup?.inline_keyboard ?? [];
}

function languageOf(tgUserId: number): string | null {
  const row = sqlite
    .prepare('SELECT language FROM customers WHERE telegram_user_id = ?1')
    .get(String(tgUserId)) as { language: string | null } | undefined;
  return row?.language ?? null;
}

function sessionFor(tgUserId: number): { state: string; data: Record<string, unknown> } {
  const row = sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .get(String(tgUserId)) as { state: string; data: string } | undefined;
  return row ? { state: row.state, data: JSON.parse(row.data) } : { state: 'IDLE', data: {} };
}

let uid = 960000000;
const freshUser = (tag: string, languageCode?: string) => ({
  ...USER,
  id: ++uid,
  username: `p10_${tag}_${uid}`,
  ...(languageCode !== undefined ? { language_code: languageCode } : {}),
});

/** Register, choose English through the selector, assert the switch landed. */
async function toEnglish(user: typeof USER): Promise<void> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:lang', nextId(), user));
  await dispatch(callbackUpdateAs('lang:en', nextId(), user));
  assert.equal(languageOf(user.id), 'en');
}

/** Walk the buy ladder as an English user up to (not incl.) confirm. */
async function englishBuyToSummary(user: typeof USER): Promise<void> {
  await toEnglish(user);
  stub.reset();
  await dispatch(messageUpdateAs(user, en.menuBuy, nextId()));
  assert.equal(sessionFor(user.id).state, 'WAITING_CONFIG_NAME');
  await dispatch(messageUpdateAs(user, 'silver falcon network', nextId()));
  assert.equal(sessionFor(user.id).state, 'WAITING_VOLUME');
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_DEVICE_LIMIT');
  await dispatch(callbackUpdateAs('dev:2', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_ORDER_CONFIRMATION');
}

/** Confirm + receipt → awaiting_review; returns the order id. */
async function englishBuyToReceipt(user: typeof USER): Promise<string> {
  await englishBuyToSummary(user);
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), user));
  const orderId = String(sessionFor(user.id).data['order_id']);
  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `P10_${nextId()}` }, user));
  return orderId;
}

/* ————————————————————— default: nobody auto-switches ————————————————————— */

test('NO auto-detect: an en-client newcomer still gets Persian, hint stays display-only', async () => {
  const hero = freshUser('nodetect', 'en-US');
  stub.reset();
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const welcome = lastBubble(hero.id);
  assert.ok(String(welcome.text).includes('درود'), 'fa is the default for everyone');
  const labels = (replyKbOf(welcome.payload)?.keyboard ?? []).flat().map((b) => b.text);
  assert.ok(labels.includes(fa.menuBuy));
  assert.ok(labels.includes(en.menuLanguage), 'the selector button is bilingual');

  await dispatch(messageUpdateAs(hero, fa.menuAccount, nextId()));
  const acct = String(lastBubble(hero.id).text);
  assert.ok(acct.includes(fa.accountBotLanguage(fa.accountLanguageFa)));
  assert.ok(acct.includes(fa.accountLanguage('en-US')), 'hint visible, never effective');
});

/* ————————————————————— the selector ————————————————————— */

test('selector: open picker → English persists in D1 and replaces the keyboards', async () => {
  const hero = freshUser('picker');
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, fa.menuLanguage, nextId()));
  const picker = lastBubble(hero.id);
  assert.equal(String(picker.text), fa.languageIntro);
  assert.deepEqual(
    inlineKbOf(picker.payload).flat().map((b) => b.callback_data),
    ['lang:fa', 'lang:en', 'act:back_menu'],
  );

  await dispatch(callbackUpdateAs('lang:en', nextId(), hero));
  const conf = lastBubble(hero.id);
  assert.equal(String(conf.text), en.languageSet);
  const labels = (replyKbOf(conf.payload)?.keyboard ?? []).flat().map((b) => b.text);
  assert.ok(labels.includes(en.menuBuy), 'persistent reply keyboard now English');
  assert.equal(languageOf(hero.id), 'en');

  // /start again — even with a flipped Telegram hint: still English forever.
  stub.reset();
  await dispatch(messageUpdateAs({ ...USER, id: hero.id, username: hero.username, language_code: 'fa' }, '/start', nextId()));
  const reWelcome = String(lastBubble(hero.id).text);
  assert.equal(PERSIAN.test(reWelcome), false, 'no Persian leaked into the English welcome');
  assert.ok(reWelcome.includes('welcome'), 'English welcome');

  // Switch back — persisted + confirmed in Persian.
  await dispatch(callbackUpdateAs('menu:lang', nextId(), hero));
  await dispatch(callbackUpdateAs('lang:fa', nextId(), hero));
  assert.equal(languageOf(hero.id), 'fa');
  assert.equal(String(lastBubble(hero.id).text), fa.languageSet);
});

test('a mid-purchase switch keeps the flow and re-renders keyboards in the new language', async () => {
  const hero = freshUser('midflow');
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(messageUpdateAs(hero, fa.menuBuy, nextId()));
  assert.equal(sessionFor(hero.id).state, 'WAITING_CONFIG_NAME');
  await dispatch(callbackUpdateAs('menu:lang', nextId(), hero));
  await dispatch(callbackUpdateAs('lang:en', nextId(), hero));
  assert.equal(sessionFor(hero.id).state, 'WAITING_CONFIG_NAME', 'the ladder survived the switch');
  // The confirmation restored the CONFIG-NAME composing keyboard — in English.
  const compose = (replyKbOf(lastBubble(hero.id).payload)?.keyboard ?? []).flat().map((b) => b.text);
  assert.deepEqual(compose, [en.btnAutoPick, en.backToMenu]);
  await dispatch(messageUpdateAs(hero, 'north valley signal', nextId()));
  assert.equal(sessionFor(hero.id).state, 'WAITING_VOLUME');
  assert.ok(String(lastBubble(hero.id).text).includes('GB'), 'English volume prompt');
});

/* ————————————————————— stale keyboards still route ————————————————————— */

test('a stale PERSIAN tap from an English session routes to the English screen', async () => {
  const hero = freshUser('stale');
  await toEnglish(hero);
  stub.reset();
  await dispatch(messageUpdateAs(hero, fa.menuWallet, nextId())); // old fa keycap
  assert.ok(String(lastBubble(hero.id).text).includes(en.walletHeader));
  stub.reset();
  await dispatch(messageUpdateAs(hero, fa.backToMenu, nextId())); // old fa back keycap
  assert.ok(textsTo(hero.id).includes(en.idleMenuNudge), 'English idle nudge');
  assert.equal(sessionFor(hero.id).state, 'IDLE');
});

/* ————————————————————— the English purchase walk ————————————————————— */

test('buy renders English throughout: rejects, composer, auto-pick, reactions', async () => {
  const hero = freshUser('buy');
  await toEnglish(hero);
  await dispatch(messageUpdateAs(hero, en.menuBuy, nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'x', nextId())); // invalid name
  assert.ok(String(lastBubble(hero.id).text).includes("doesn't work"), 'English name rejection');

  const hero2 = freshUser('buy2');
  await englishBuyToSummary(hero2);
  const summary = textsTo(hero2.id).find((x) => x.includes(en.summaryHeader))!;
  assert.ok(summary.includes('Toman'), 'English money style');
  assert.ok(summary.includes(en.menuSupport) === false);
  const confKb = inlineKbOf(lastBubble(hero2.id).payload).flat().map((b) => b.text);
  assert.ok(confKb.includes(en.confirmYes));
  assert.ok(String(summary).includes('two devices'), `English reaction leads the summary: ${summary}`);

  // custom numeric out-of-range rejection stays in-domain (GB)
  const hero3 = freshUser('buy3');
  await toEnglish(hero3);
  await dispatch(messageUpdateAs(hero3, en.menuBuy, nextId()));
  await dispatch(messageUpdateAs(hero3, 'quiet harbor relay', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero3, '5', nextId())); // below minimum volume
  assert.ok(String(lastBubble(hero3.id).text).includes('GB'), 'English volume rejection');
  await dispatch(messageUpdateAs(hero3, en.btnAutoPick, nextId())); // still name step? No: volume step now
  assert.equal(sessionFor(hero3.id).state, 'WAITING_VOLUME', 'auto-pick is inert outside the name step');
});

test('payment instructions + receipt confirmation arrive in English (HTML preserved)', async () => {
  // payment_info is ADMIN-AUTHORED SETTINGS CONTENT (Phase 10 out-of-scope):
  // the bot renders it verbatim — an English-facing operator replaces the
  // seeded Persian doc, and only the bot's own copy is localized.
  sqlite
    .prepare(`UPDATE settings SET value = '{"schema": 1, "holder": "Zero Fee Trading", "iban": null, "instructions": "Transfer the exact amount, then send the receipt."}' WHERE key = 'payment_info'`)
    .run();
  const hero = freshUser('pay');
  await englishBuyToSummary(hero);
  stub.reset();
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), hero));
  const orderId = String(sessionFor(hero.id).data['order_id']);
  const creates = textsTo(hero.id).find((x) => x.includes('Order placed'))!;
  assert.ok(creates.includes(orderId.slice(0, 4)), 'English order-created bubble');
  const instructions = sendsTo(hero.id).find((s) => s.payload['parse_mode'] === 'HTML')!;
  const itext = String(instructions.text);
  assert.ok(itext.includes(en.paymentInstructionsHeader));
  assert.ok(itext.includes('<code>'), 'the card is tap-to-copy code');
  assert.ok(itext.includes(TEST_CARD), 'the configured card renders');
  assert.equal(PERSIAN.test(itext), false, 'no Persian in the English payment bubble');

  await dispatch(mediaUpdate(nextId(), { kind: 'photo', fileId: `RC_${nextId()}` }, hero));
  const receipt = textsTo(hero.id).at(-1)!;
  assert.ok(String(receipt).includes('Receipt received'), 'English receipt ack');
  const forwarded = stub.sent.filter((s) => s.method === 'sendPhoto');
  assert.ok(forwarded.length > 0, 'receipt forwarded to admins');
  assert.ok(
    forwarded.every((s) => String(s.payload['caption']).includes('🧾 فیش جدید')),
    'admin forward caption stays Persian',
  );

  // My Orders in English — menu shortcuts only answer from IDLE (existing
  // rule), so /cancel ends the receipt-wait conversation first.
  await dispatch(messageUpdateAs(hero, '/cancel', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, en.menuOrders, nextId()));
  const list = String(lastBubble(hero.id).text);
  assert.ok(list.includes(en.ordersHeader));
  assert.ok(list.includes(en.statusAwaitingReview), 'English status label');
});

test('review echoes stay Persian for admins; the approve NOTICE follows the customer language', async () => {
  const hero = freshUser('review');
  const orderId = await englishBuyToReceipt(hero);
  stub.reset();
  await dispatch(callbackUpdateAs(`adm:ok:${orderId}`, nextId(), ADMIN));

  const adminAll =
    stub.sent
      .filter((s) => Number(s.payload['chat_id']) === ADMIN.id)
      .map((s) => String(s.text ?? s.payload['caption'] ?? ''))
      .join('\n') +
    '\n' +
    stub.sent
      .filter((s) => s.method === 'answerCallbackQuery')
      .map((s) => String(s.payload['text'] ?? ''))
      .join('\n');
  assert.ok(PERSIAN.test(adminAll), 'admin bubbles/toasts stay Persian');
  assert.equal(adminAll.includes('Order approved.'), false, 'no English admin toast');

  const notice = sendsTo(hero.id).find((s) => String(s.text).includes('confirmed'));
  assert.ok(notice, 'approval notice delivered');
  const ntext = String(notice.text);
  assert.ok(ntext.includes('payment is confirmed'), `English approval expected: ${ntext}`);
  assert.ok(ntext.includes('Toman'), 'English money');
  assert.equal(PERSIAN.test(ntext), false, 'no Persian in the English notice');
});

/* ————————————————————— English informational screens ————————————————————— */

test('empty services/orders, wallet, invite, support and the off-topic hint all render in English', async () => {
  const hero = freshUser('screens');
  await toEnglish(hero);

  stub.reset();
  await dispatch(messageUpdateAs(hero, en.menuServices, nextId()));
  assert.ok(String(lastBubble(hero.id).text).includes(en.servicesEmpty));
  await dispatch(messageUpdateAs(hero, en.menuOrders, nextId()));
  assert.ok(String(lastBubble(hero.id).text).includes(en.ordersEmpty));
  await dispatch(messageUpdateAs(hero, en.menuWallet, nextId()));
  assert.ok(String(lastBubble(hero.id).text).includes('Balance: 0 Toman'.split(' ')[0]));
  await dispatch(messageUpdateAs(hero, en.menuInvite, nextId()));
  assert.ok(String(lastBubble(hero.id).text).includes(en.inviteHeader));
  await dispatch(messageUpdateAs(hero, en.menuSupport, nextId()));
  assert.ok(String(lastBubble(hero.id).text).includes('Support'));
  assert.equal(sessionFor(hero.id).state, 'WAITING_SUPPORT_MESSAGE');
  stub.reset();
  await dispatch(messageUpdateAs(hero, en.backToMenu, nextId()));
  assert.equal(sessionFor(hero.id).state, 'IDLE');
  await dispatch(messageUpdateAs(hero, 'just some random english chatter', nextId()));
  const hint = String(lastBubble(hero.id).text);
  assert.ok(hint.includes('bot'), 'English off-topic hint');
  assert.equal(hint, en.idleInputHint);
});

test('an English ticket reply wrapper reads English while admin relays stay Persian', async () => {
  const hero = freshUser('support');
  await toEnglish(hero);
  await dispatch(messageUpdateAs(hero, en.menuSupport, nextId()));
  await dispatch(messageUpdateAs(hero, 'My connection drops every morning.', nextId()));
  assert.ok(textsTo(hero.id).some((x) => x.includes('Ticket ID')), 'English creation ack');
  const ticket = sqlite
    .prepare('SELECT id FROM support_tickets ORDER BY rowid DESC LIMIT 1')
    .get() as { id: string };
  stub.reset();
  await dispatch(callbackUpdateAs(`tsk:rp:${ticket.id}`, nextId(), ADMIN));
  await dispatch(messageUpdateAs(ADMIN, 'درود، بررسی شد، مشکل از گره كانتر بود.', nextId()));
  const customerBubble = sendsTo(hero.id).at(-1)!;
  assert.ok(String(customerBubble.text).startsWith(en.supportAnswered), 'English reply wrapper');
  assert.ok(String(customerBubble.text).includes('بررسی شد'), 'admin body verbatim');
  assert.ok(
    inlineKbOf(customerBubble.payload).flat().some((b) => b.text === en.backToMenu),
    'English acknowledge button',
  );
});

/* ————————————————————— sweeps follow the recipient ————————————————————— */

test('payment-reminder sweep: English nudge, Persian admin digest', async () => {
  const hero = freshUser('remind');
  const orderId = await englishBuyToReceipt(hero);
  const anchor = sqlite
    .prepare('SELECT created_at FROM payment_reminders WHERE order_id = ?1')
    .get(orderId) as { created_at: string };
  sqlite
    .prepare('UPDATE payment_reminders SET created_at = ?2 WHERE order_id = ?1')
    .run(orderId, new Date(Date.parse(anchor.created_at) - 20 * 60_000).toISOString());
  stub.reset();
  const { runPaymentReminderSweep } = await import('../src/handlers/paymentReminders.ts');
  const r = await runPaymentReminderSweep(env, Date.now());
  assert.ok(r.customerMessages >= 1);
  const nudges = sendsTo(hero.id).map((s) => String(s.text));
  assert.ok(nudges.some((x) => x.includes(orderId) && /⏳/.test(x) && !PERSIAN.test(x)));
  const faNudge = nudges.find((x) => x.includes(orderId))!;
  assert.ok(faNudge.includes('being reviewed') || faNudge.includes('still'), 'English stage copy');
  const digest = sendsTo(ADMIN.id).map((s) => String(s.text)).join('\n');
  assert.ok(digest.includes('فیش'), 'admin digest stays Persian');
});

test('expiry-notice sweep: the once-per-service promise localizes per recipient', async () => {
  // Two completed purchases about to expire — one English, one Persian.
  const enHero = freshUser('enexp');
  const faHero = freshUser('faexp');
  await toEnglish(enHero);
  await dispatch(messageUpdateAs(faHero, '/start', nextId())); // default Persian
  const ids: Record<string, string> = {};
  const mk = (customer: number, key: string) => {
    const id = newOrderId();
    ids[key] = id;
    sqlite
      .prepare(
        `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency,
                             service_created_at, service_expires_at, created_at, updated_at)
         VALUES (?1, ?2, 'completed', 'purchase', ?3, 1, 'IRT', ?4, ?5, ?4, ?4)`,
      )
      .run(
        id, customer,
        JSON.stringify({ config_name: 'north valley signal', volume_gb: 10, duration_days: 30, device_count: 1 }),
        new Date(Date.now() - 29 * 86_400_000).toISOString(),
        new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
      );
  };
  const enCid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(enHero.id)) as { id: number }).id;
  const faCid = (sqlite.prepare('SELECT id FROM customers WHERE telegram_user_id = ?1').get(String(faHero.id)) as { id: number }).id;
  mk(enCid, 'ENX');
  mk(faCid, 'FAX');
  for (const key of ['ENX', 'FAX']) {
    assert.equal(
      (sqlite.prepare('SELECT COUNT(*) n FROM orders WHERE id = ?1').get(ids[key]!) as { n: number }).n,
      1, `${key}: order row present`,
    );
  }

  stub.reset();
  const { runServiceNotificationSweep } = await import('../src/handlers/serviceNotifications.ts');
  const r = await runServiceNotificationSweep(env, Date.now());
  assert.equal(r.expirySent, 2);

  const enSends = sendsTo(enHero.id).map((s) => String(s.text));
  const enNotice = enSends.find((x) => x.includes('north valley signal'))!;
  assert.match(enNotice, /expires in \d+ days?( \d+ hours?)?/, `English remaining expected: ${enNotice}`);
  assert.ok(enNotice.includes('UTC'), 'English expiry stamp');
  assert.equal(PERSIAN.test(enNotice), false, 'no Persian leaks into the English notice');
  assert.ok(
    inlineKbOf(sendsTo(enHero.id).find((s) => String(s.text).includes('north valley'))!.payload)
      .flat().some((b) => b.text === en.serviceNoticeView),
    'English notice keyboard',
  );
  const faNotice = sendsTo(faHero.id).map((s) => String(s.text)).find((x) => x.includes('north valley'))!;
  assert.ok(faNotice.startsWith('درود زیبا،'), 'Persian keeps its persona opener');

  // Idempotency is untouched: the very next run sends nothing again.
  stub.reset();
  const again = await runServiceNotificationSweep(env, Date.now());
  assert.equal(again.expirySent, 0);
});

/* ————————————————————— persistence guarantees ————————————————————— */

test('a profile update with a new language_code hint never touches the explicit choice', async () => {
  const hero = freshUser('persist', 'en');
  await toEnglish(hero);
  const before = languageOf(hero.id);
  assert.equal(before, 'en');
  // Telegram sends the next update with a flipped client language:
  await dispatch(messageUpdateAs({ ...hero, language_code: 'fa' }, '/start', nextId()));
  assert.equal(languageOf(hero.id), 'en', 'the stored choice survives profile churn');
  const welcome = String(lastBubble(hero.id).text);
  assert.equal(PERSIAN.test(welcome), false);
});

test('menu:lang is inert for every callback forgery shape the wire allows', async () => {
  const hero = freshUser('forge');
  await toEnglish(hero);
  for (const forged of ['lang:xx', 'lang:en ', 'LANG:en', 'lang:', 'lang:en:extra']) {
    stub.reset();
    await dispatch(callbackUpdateAs(forged, nextId(), hero));
    assert.equal(languageOf(hero.id), 'en', 'no forged tap moved anything');
    assert.equal(sessionFor(hero.id).state, 'IDLE');
  }
  // the picker itself changed no language when only the intro was opened
  stub.reset();
  await dispatch(callbackUpdateAs('menu:lang', nextId(), hero));
  assert.ok(!sendsTo(hero.id).some((s) => String(s.text).includes(en.languageSet)));
});
