/**
 * Phase 11 e2e: the connection guide, both transports, both languages.
 * Fully offline (D1 shim + fetch stub). Pins: Persian default without any
 * explicit choice, English only after the explicit Phase 10 choice, stale
 * other-locale taps still routing, official URLs and the two reviewed safety
 * sentences on the wire — while `conversation_states` stays PROVABLY empty.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  TEST_CARD,
  USER,
  USER_EN_CLIENT,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdateAs,
} from './helpers.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { CB } = await import('../src/telegram/menu.ts');
const { fa } = await import('../src/telegram/texts.ts');
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

let counter = 118000;
const nextId = () => ++counter;

function sendsTo(chatId: number) {
  return stub.sent.filter(
    (s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId,
  );
}
function textsTo(chatId: number) {
  return sendsTo(chatId).map((s) => String(s.text));
}
function inlineRows(payload: Record<string, unknown>) {
  const markup = payload['reply_markup'] as
    | { inline_keyboard?: Array<Array<{ text?: string; url?: string; callback_data?: string }>> }
    | undefined;
  return markup?.inline_keyboard ?? [];
}
function lastBubbleInline(chatId: number) {
  return inlineRows(sendsTo(chatId).at(-1)!.payload);
}
function stateRowsFor(tgUserId: number): Array<{ state: string; data: string }> {
  return sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = ?1`,
    )
    .all(String(tgUserId)) as Array<{ state: string; data: string }>;
}

const GUIDE_LABEL_FA = '📚 راهنمای اتصال';
const GUIDE_LABEL_EN = '📚 Connection guide';

test('Persian default: text-tap walk through all screens, official links, zero session writes', async () => {
  const hero = { ...USER, id: 911000001, username: 'p11_fa_walk' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();

  await dispatch(messageUpdateAs(hero, GUIDE_LABEL_FA, nextId()));
  assert.ok(textsTo(hero.id).some((x) => x.includes(fa.guideIntro)), 'fa intro bubble');
  assert.deepEqual(
    lastBubbleInline(hero.id).map((r) => r.map((b) => b.callback_data)),
    [[CB.GUIDE_ANDROID, CB.GUIDE_IOS], [CB.GUIDE_WINDOWS], [CB.ACT_BACK_MENU]],
  );

  await dispatch(callbackUpdateAs(CB.GUIDE_ANDROID, nextId(), hero));
  let texts = textsTo(hero.id);
  assert.ok(texts.some((x) => x.includes('اتصال با اندروید')), 'android screen');
  const rows = lastBubbleInline(hero.id);
  assert.equal(rows[0]?.[0]?.text, '📖 راهنمای اتصال — incy', 'app order: incy first');
  assert.equal(rows[1]?.[0]?.text, '📖 راهنمای اتصال — v2RayTun');
  assert.equal(rows[2]?.[0]?.text, '📖 راهنمای اتصال — v2rayNG');

  await dispatch(callbackUpdateAs(CB.GUIDE_AND_TUN, nextId(), hero));
  texts = textsTo(hero.id);
  const tun = textsTo(hero.id).at(-1)!;
  assert.ok(tun.includes('v2RayTun — اتصال در یک دقیقه'));
  assert.ok(tun.includes('شمارنده'));
  const tunRows = lastBubbleInline(hero.id);
  assert.deepEqual(tunRows[0]?.map((b) => [b.text, b.url]), [
    ['📥 Google Play', 'https://play.google.com/store/apps/details?id=com.v2raytun.android'],
    ['📦 GitHub', 'https://github.com/v2RayTun'],
  ]);
  assert.equal(tunRows[1]?.[0]?.callback_data, CB.GUIDE_ANDROID, 'other-apps re-opens screen 2');

  await dispatch(callbackUpdateAs(CB.GUIDE_AND_NG, nextId(), hero));
  const ngRows = lastBubbleInline(hero.id);
  assert.deepEqual(ngRows[0]?.map((b) => b.url), [
    'https://github.com/2dust/v2rayNG/releases',
    'https://github.com/2dust/v2rayNG',
  ], 'no Play button on unverified v2rayNG listing');
  assert.ok(textsTo(hero.id).at(-1)?.includes('2dust/v2rayNG'));

  await dispatch(callbackUpdateAs(CB.GUIDE_AND_INCY, nextId(), hero));
  assert.ok(textsTo(hero.id).at(-1)?.includes('incy — اتصال در یک دقیقه'), 'incy steps bubble');
  assert.deepEqual(lastBubbleInline(hero.id)[0]?.map((b) => [b.text, b.url]), [
    ['📥 Google Play', 'https://play.google.com/store/apps/details?id=llc.itdev.incy'],
  ], 'incy Play link exact');

  await dispatch(callbackUpdateAs(CB.GUIDE_WINDOWS, nextId(), hero));
  const winRows = lastBubbleInline(hero.id);
  assert.equal(winRows.length, 3, 'single 📖 row + other platforms + menu');
  assert.equal(winRows[0]?.[0]?.text, '📖 راهنمای اتصال — Throne');
  await dispatch(callbackUpdateAs(CB.GUIDE_WIN_THRONE, nextId(), hero));
  assert.ok(textsTo(hero.id).at(-1)?.includes('SmartScreen'));
  assert.ok(textsTo(hero.id).at(-1)?.includes('صفحهٔ رسمی Releases'));

  // A forged well-formed-but-unknown tap: neutral alert, NO bubble, no state.
  const before = sendsTo(hero.id).length;
  await dispatch(callbackUpdateAs('gud:android_extra', nextId(), hero));
  assert.equal(sendsTo(hero.id).length, before, 'no sendMessage for unknown gud:');
  const toast = stub.sent.filter((s) => s.method === 'answerCallbackQuery').at(-1);
  assert.equal(String(toast?.payload['text']), fa.invalidChoice);
  assert.equal(toast?.payload['show_alert'], true);

  // Legacy exit stays exactly the Phase 10 path: edit + idle nudge.
  await dispatch(callbackUpdateAs(CB.ACT_BACK_MENU, nextId(), hero));
  const edit = stub.sent.filter((s) => s.method === 'editMessageText').at(-1);
  assert.ok(edit, 'back from a guide bubble lands on the idle nudge edit');
  assert.deepEqual(
    (edit!.payload['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard,
    [],
  );

  assert.deepEqual(stateRowsFor(hero.id), [], 'the guide never touches conversation_states');
});

test('explicit English choice drives every guide screen (safety sentences verbatim)', async () => {
  const hero = { ...USER, id: 911000002, username: 'p11_en_walk' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(callbackUpdateAs(CB.LANG_EN, nextId(), hero));
  stub.reset();

  await dispatch(messageUpdateAs(hero, GUIDE_LABEL_EN, nextId()));
  assert.ok(textsTo(hero.id).some((x) => x.includes(en.guideIntro)), 'en intro');
  assert.ok(textsTo(hero.id).every((x) => !x.includes('اتصال')), 'no Persian on the wire');

  await dispatch(callbackUpdateAs(CB.GUIDE_ANDROID, nextId(), hero));
  assert.ok(textsTo(hero.id).at(-1)?.includes('Connecting on Android'));

  await dispatch(callbackUpdateAs(CB.GUIDE_AND_INCY, nextId(), hero));
  assert.ok(textsTo(hero.id).at(-1)?.includes('incy — connect in a minute'), 'en incy steps bubble');

  await dispatch(callbackUpdateAs(CB.GUIDE_AND_NG, nextId(), hero));
  assert.ok(
    textsTo(hero.id).at(-1)?.includes(
      'make sure you are installing the release from the official 2dust/v2rayNG GitHub page',
    ),
  );

  await dispatch(callbackUpdateAs(CB.GUIDE_WIN_THRONE, nextId(), hero));
  assert.ok(
    textsTo(hero.id).at(-1)?.includes(
      'verify that you downloaded Throne from the official GitHub releases page before continuing',
    ),
  );
  assert.deepEqual(stateRowsFor(hero.id), []);
});

test('a stale fa-tap from an English bot still guides in English (labels never gate)', async () => {
  const hero = { ...USER, id: 911000003, username: 'p11_stale' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(callbackUpdateAs(CB.LANG_EN, nextId(), hero));
  stub.reset();

  await dispatch(messageUpdateAs(hero, GUIDE_LABEL_FA, nextId()));
  assert.ok(textsTo(hero.id).some((x) => x.includes(en.guideIntro)), 'English from a fa label');
});

test('Telegram language_code hint alone NEVER selects English for the guide', async () => {
  // USER_EN_CLIENT: client hint 'en', explicit choice absent → Persian.
  await dispatch(messageUpdateAs(USER_EN_CLIENT, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(USER_EN_CLIENT, GUIDE_LABEL_FA, nextId()));
  assert.ok(textsTo(USER_EN_CLIENT.id).some((x) => x.includes(fa.guideIntro)));
});

test('guide tap from a legacy inline menu mid-purchase: screens appear, flow and data untouched', async () => {
  const hero = { ...USER, id: 911000004, username: 'p11_busy' };
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(messageUpdateAs(hero, '🛒 خرید سرویس', nextId()));
  await dispatch(messageUpdateAs(hero, 'north valley signal', nextId()));
  const states = stateRowsFor(hero.id);
  assert.equal(states.length, 1, 'purchase created its session row');
  assert.equal(states[0]!.state, 'WAITING_VOLUME');
  stub.reset();

  await dispatch(callbackUpdateAs(CB.MENU_GUIDE, nextId(), hero));
  assert.ok(textsTo(hero.id).some((x) => x.includes(fa.guideIntro)), 'guide from busy state');
  await dispatch(callbackUpdateAs(CB.GUIDE_IOS, nextId(), hero));
  const afterStates = stateRowsFor(hero.id);
  assert.deepEqual(afterStates.map((r) => [r.state, r.data]), states.map((r) => [r.state, r.data]),
    'purchase session byte-identical after a full guide walk');
});

test('text transport and legacy callback transport render the guide identically', async () => {
  const viaText = { ...USER, id: 911000005, username: 'p11_twin_t' };
  const viaCb = { ...USER, id: 911000006, username: 'p11_twin_c' };
  await dispatch(messageUpdateAs(viaText, '/start', nextId()));
  await dispatch(messageUpdateAs(viaCb, '/start', nextId()));
  stub.reset();
  await dispatch(callbackUpdateAs(CB.MENU_GUIDE, nextId(), viaCb));
  const cbTexts = textsTo(viaCb.id);
  stub.reset();
  await dispatch(messageUpdateAs(viaText, GUIDE_LABEL_FA, nextId()));
  assert.equal(cbTexts.length > 0, true);
  assert.deepEqual(textsTo(viaText.id), cbTexts);
});
