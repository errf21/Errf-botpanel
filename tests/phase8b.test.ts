/**
 * Phase 8B e2e: Personality & User Experience.
 * Fully offline (D1 shim over migrations 0001-0007 + fetch stub).
 * Locks the approved persona rules:
 *  - exact global OFF-TOPIC fallback (byte-frozen) and the softer idle nudge,
 *  - flow-specific validation messages (volume/duration/device each in-domain),
 *  - display-only device/volume reactions riding on the NEXT bubble,
 *  - «درود زیبا» greeting used only where natural, NEVER سلام, and never
 *    forced into mid-flow prompts,
 *  - state/price/keyboard behavior of every flow is unchanged (personality is
 *    copy-only; business validation stays in the catalog guards).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdateAs,
} from './helpers.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const { fa, deviceReaction, volumeReaction } = await import('../src/telegram/texts.ts');

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

let counter = 90000;
const nextId = () => ++counter;

const replyKbOf = (payload: Record<string, unknown>) => {
  const markup = payload['reply_markup'] as
    | { keyboard?: Array<Array<{ text: string; style?: string }>> }
    | undefined;
  return markup && Array.isArray(markup.keyboard) ? markup : undefined;
};
const sentTo = (chatId: number) =>
  stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const sendsTo = (chatId: number) => sentTo(chatId).filter((s) => s.method === 'sendMessage');
const textsTo = (chatId: number) => sendsTo(chatId).map((s) => String(s.text));
const lastBubble = (chatId: number) => sendsTo(chatId).at(-1)!;

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

let uid = 830000000;
const freshUser = (tag: string) => ({
  ...USER,
  id: ++uid,
  username: `p8b_${tag}_${uid}`,
});

/** /start → buy → typed valid name → land on WAITING_VOLUME. */
async function buyToVolume(user: typeof USER): Promise<void> {
  await dispatch(messageUpdateAs(user, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_CONFIG_NAME');
  await dispatch(messageUpdateAs(user, 'north valley signal', nextId()));
  assert.equal(sessionFor(user.id).state, 'WAITING_VOLUME');
}

/** Continue from WAITING_VOLUME: volume 10 → duration 30 → WAITING_DEVICE_LIMIT. */
async function toDeviceStep(user: typeof USER): Promise<void> {
  await dispatch(callbackUpdateAs('vol:10', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_DURATION');
  await dispatch(callbackUpdateAs('dur:30', nextId(), user));
  assert.equal(sessionFor(user.id).state, 'WAITING_DEVICE_LIMIT');
}

// ————————————————————————————— the frozen persona strings —————————————————————————————

test('global fallback is the EXACT approved copy, byte-for-byte', () => {
  assert.equal(
    fa.idleInputHint,
    'مشتی من رباتماا😅 نمیتونم مثل شما حرف بزنم بی زحمت از منوی موجود استفاده کن،دمت گرم',
  );
  // The soft idle nudge is a SEPARATE line — never the joke fallback.
  assert.notEqual(fa.idleMenuNudge, fa.idleInputHint);
});

test('device/volume reaction copy is pinned to the corrected wording', () => {
  assert.equal(deviceReaction(1), null, 'single user/device → plain confirmation');
  assert.equal(deviceReaction(2), 'دمت گرم، تک‌خور نیستی 😄 دوکاربره انتخاب کردی');
  assert.equal(deviceReaction(3), 'ایول، سه‌کاربره انتخاب کردی 😄');
  // ≥4 stays proportional, names the count (Persian digits), friendly not silly.
  assert.equal(deviceReaction(5), '۵ کاربره انتخاب کردی، چه تیم پرجمعیتی 😄');
  assert.equal(deviceReaction(10), '۱۰ کاربره انتخاب کردی، چه تیم پرجمعیتی 😄');

  assert.equal(volumeReaction(10), null);
  assert.equal(volumeReaction(20), null, 'threshold is strictly ABOVE 20');
  assert.equal(volumeReaction(30), 'عووو چه دست‌ودلباز، خوشمان آمد 😄');
});

test('welcome + approval greetings follow «درود زیبا» (and never سلام)', () => {
  assert.equal(fa.welcomeGreeting(null), '👋 درود زیبا، به ربات خوش اومدی ❤️');
  assert.equal(fa.welcomeGreeting('Ali'), '👋 درود Ali، به ربات خوش اومدی ❤️');
  assert.ok(fa.notifyApproved('ord_1', '1,000').startsWith('درود زیبا'));
  for (const text of [fa.welcomeGreeting(null), fa.notifyApproved('a', 'b')]) {
    assert.equal(text.includes('سلام'), false, 'greeting must be درود, never سلام');
  }
});

// ————————————————————————————— fallback routing —————————————————————————————

test('off-topic free text at IDLE → exact fallback + persistent menu restored', async () => {
  const hero = freshUser('idle_junk');
  stub.reset();
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'asdkj qwe rty', nextId()));
  assert.equal(sessionFor(hero.id).state, 'IDLE', 'personality never mutates state');
  assert.equal(String(lastBubble(hero.id).text), fa.idleInputHint);
  assert.ok(
    (replyKbOf(lastBubble(hero.id).payload)?.keyboard ?? []).flat().some((b) => b.text === '🛒 خرید سرویس'),
    'main keyboard restored on the fallback',
  );
});

test('deliberate back-tap while idle → soft nudge, NOT the joke fallback', async () => {
  const hero = freshUser('idle_back');
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  stub.reset();
  await dispatch(messageUpdateAs(hero, fa.backToMenu, nextId()));
  const bubble = lastBubble(hero.id);
  assert.equal(String(bubble.text), fa.idleMenuNudge);
  assert.equal(String(bubble.text).includes('مشتی'), false);
});

test('fallback NEVER leaks into a defined flow (bad config name)', async () => {
  const hero = freshUser('flow_name');
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), hero));
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'x', nextId())); // invalid name
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.includes('نامعتبر'), `expected config-name validator: ${text}`);
  assert.equal(text.includes('مشتی'), false, 'validator, not off-topic fallback');
  assert.equal(sessionFor(hero.id).state, 'WAITING_CONFIG_NAME', 'state preserved');
});

test('mid-summary typing re-shows the summary, never the fallback', async () => {
  const hero = freshUser('mid_summary');
  await buyToVolume(hero);
  await toDeviceStep(hero);
  await dispatch(callbackUpdateAs('dev:3', nextId(), hero));
  assert.equal(sessionFor(hero.id).state, 'WAITING_ORDER_CONFIRMATION');
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'salam? hello??', nextId()));
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.includes('خلاصه سفارش') || text.includes('قیمت کل'), `summary re-render: ${text}`);
  assert.equal(text.includes('مشتی'), false);
});

// ————————————————————————————— flow-specific validation —————————————————————————————

test('below-minimum volume is answered in its OWN domain, state kept', async () => {
  const hero = freshUser('vol_lo');
  await buyToVolume(hero);
  stub.reset();
  await dispatch(messageUpdateAs(hero, '۵', nextId())); // Persian 5 < min 10
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.includes('حجم'), `volume-specific copy expected: ${text}`);
  assert.equal(text.includes('گیگابایت'), true);
  assert.equal(sessionFor(hero.id).state, 'WAITING_VOLUME');
});

test('duration & device range rejections stay in their own wording', async () => {
  const hero = freshUser('dur_dev_range');
  await buyToVolume(hero);
  await dispatch(callbackUpdateAs('vol:10', nextId(), hero)); // → duration step
  assert.equal(sessionFor(hero.id).state, 'WAITING_DURATION');
  stub.reset();
  await dispatch(messageUpdateAs(hero, '۵۰۰۰', nextId())); // 5000 > max 365
  assert.ok(String(lastBubble(hero.id).text).includes('روز'), 'duration rejection says «روز»');
  assert.ok(String(lastBubble(hero.id).text).includes('مدت'), 'duration rejection says «مدت»');
});

test('device range rejection says «دستگاه»', async () => {
  const hero = freshUser('dev_range');
  await buyToVolume(hero);
  await toDeviceStep(hero);
  stub.reset();
  await dispatch(messageUpdateAs(hero, '۲۰', nextId())); // 20 > max 10
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.includes('دستگاه'), `device-specific copy expected: ${text}`);
  assert.equal(sessionFor(hero.id).state, 'WAITING_DEVICE_LIMIT');
});

// ————————————————————————————— reactions ride the next bubble —————————————————————————————

test('volume above 20 rides the «عووو» line onto the duration prompt only', async () => {
  const hero = freshUser('vol_react');
  await buyToVolume(hero);
  stub.reset();
  await dispatch(callbackUpdateAs('vol:30', nextId(), hero)); // 30 > 20
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.startsWith('عووو'), `reaction leads the bubble: ${text}`);
  assert.ok(text.includes('مدت سرویس'), 'the next-step prompt still follows');
  assert.equal(sessionFor(hero.id).data['volume_gb'], 30, 'business value unchanged');

  const plain = freshUser('vol_plain');
  await buyToVolume(plain);
  stub.reset();
  await dispatch(callbackUpdateAs('vol:10', nextId(), plain)); // 10 ≤ 20
  const plainText = String(lastBubble(plain.id).text);
  assert.equal(plainText.includes('عووو'), false, 'normal volume is not over-hyped');
  assert.ok(plainText.startsWith('⏳'), 'plain duration prompt');
});

test('duration choice is never hyped: the device prompt arrives plain', async () => {
  const hero = freshUser('dur_silent');
  await buyToVolume(hero);
  await dispatch(callbackUpdateAs('vol:10', nextId(), hero));
  stub.reset();
  await dispatch(callbackUpdateAs('dur:90', nextId(), hero));
  assert.equal(sessionFor(hero.id).state, 'WAITING_DEVICE_LIMIT');
  const text = String(lastBubble(hero.id).text);
  assert.ok(text.startsWith('📱'), `plain device prompt expected: ${text}`);
  assert.equal(/(درود|عووو|😄)/.test(text), false, 'no reactions on the duration step');
});

test('device choice: 1 plain, 3 leads summary, 2 (preset) leads with «دوکاربره», >3 rejected out of range', async () => {
  // Single → no reaction: summary opens straight on the header.
  const solo = freshUser('dev1');
  await buyToVolume(solo);
  await toDeviceStep(solo);
  stub.reset();
  await dispatch(callbackUpdateAs('dev:1', nextId(), solo));
  assert.equal(sessionFor(solo.id).state, 'WAITING_ORDER_CONFIRMATION');
  let text = String(lastBubble(solo.id).text);
  assert.ok(text.startsWith('🧾'), `plain summary expected: ${text}`);
  assert.equal(/(😄|تک‌خور|پرجمعیت|عووو)/.test(text), false, 'no joke on a single-user pick');

  // 3 → «ایول…» leads the SAME single summary bubble (no extra message).
  const trio = freshUser('dev3');
  await buyToVolume(trio);
  await toDeviceStep(trio);
  stub.reset();
  const before = sendsTo(trio.id).length;
  await dispatch(callbackUpdateAs('dev:3', nextId(), trio));
  const sends = sendsTo(trio.id).length - before;
  assert.equal(sends, 1, 'reaction rides the existing bubble, not a new send');
  text = String(lastBubble(trio.id).text);
  assert.ok(text.startsWith('ایول، سه‌کاربره انتخاب کردی'), `3-user lead expected: ${text}`);
  assert.ok(text.includes('🧾 خلاصه سفارش'));
  assert.equal(sessionFor(trio.id).data['device_count'], 3);

  // 2 is now a preset (0012 ladder): typed free text still lands, and the
  // «دوکاربره» wording is corrected — never the banned «دوراه‌سفره».
  const duo = freshUser('dev2');
  await buyToVolume(duo);
  await toDeviceStep(duo);
  await dispatch(messageUpdateAs(duo, '۲', nextId()));
  text = String(lastBubble(duo.id).text);
  assert.ok(text.includes('دمت گرم، تک‌خور نیستی'), 'two-user acknowledgment');
  assert.ok(text.includes('دوکاربره انتخاب کردی'));
  assert.equal(text.includes('دوراه‌سفره'), false, 'banned awkward phrasing must be gone');

  // 5 → beyond the 0012 ladder (max 3): range rejection, reaction never rides.
  const five = freshUser('dev5');
  stub.reset();
  await buyToVolume(five);
  await toDeviceStep(five);
  await dispatch(callbackUpdateAs('dev:5', nextId(), five));
  assert.equal(sessionFor(five.id).state, 'WAITING_DEVICE_LIMIT', 'out-of-range stays on the step');
  const fiveText = String(lastBubble(five.id).text);
  assert.ok(fiveText.includes('دستگاه'), `device-domain rejection expected: ${fiveText}`);
  assert.equal(fiveText.includes('۵ کاربره'), false, 'no acceptance reaction for an unbuyable count');
  // The device keyboard now offers 1/2/3 only — no custom button, no typing hint.
  const devKb = sendsTo(five.id)
    .reverse()
    .find((s) => {
      const kb = s.payload['reply_markup'] as { inline_keyboard?: { callback_data: string }[][] } | undefined;
      return kb?.inline_keyboard.flat().some((b) => b.callback_data.startsWith('dev:'));
    });
  const devButtons = (
    (devKb?.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data)
  );
  assert.equal(devButtons.includes('dev:custom'), false, 'custom typing is off (0012)');
  assert.ok(devButtons.includes('dev:2'), 'preset 2 is purchasable');
  assert.equal(devButtons.includes('dev:5'), false, 'preset 5 is gone');
});

test('reaction is a one-shot prelude: a re-rendered summary never repeats it', async () => {
  const hero = freshUser('react_once');
  await buyToVolume(hero);
  await toDeviceStep(hero);
  await dispatch(callbackUpdateAs('dev:3', nextId(), hero));
  assert.ok(String(lastBubble(hero.id).text).startsWith('ایول'), 'first summary carries the reaction');
  stub.reset();
  await dispatch(messageUpdateAs(hero, 'xyzzy', nextId())); // mid-summary text → re-render
  const re = String(lastBubble(hero.id).text);
  assert.ok(re.startsWith('🧾'), `clean summary expected: ${re}`);
  assert.equal(re.includes('ایول'), false, 'greeting/reaction never repeats on re-render');
});

// ————————————————————————————— greetings are NOT sprinkled everywhere —————————————————————————————

test('mid-flow step prompts carry no forced greeting', async () => {
  const hero = freshUser('no_greet');
  await buyToVolume(hero);
  stub.reset();
  await dispatch(messageUpdateAs(hero, '۱۲', nextId())); // → duration prompt
  await dispatch(messageUpdateAs(hero, '۳۰', nextId())); // → device prompt
  const devicePrompt = String(lastBubble(hero.id).text);
  assert.ok(devicePrompt.includes('دستگاه'), `device prompt expected: ${devicePrompt}`);
  assert.equal(devicePrompt.includes('درود'), false, 'no greeting inside a live step');
});

test('welcome message uses درود and never سلام', async () => {
  const hero = freshUser('welcome');
  stub.reset();
  await dispatch(messageUpdateAs(hero, '/start', nextId()));
  const all = textsTo(hero.id).join('\n');
  assert.ok(all.includes('درود'), `expected درود: ${all}`);
  assert.equal(all.includes('سلام'), false, 'no سلام in bot-authored text');
});
