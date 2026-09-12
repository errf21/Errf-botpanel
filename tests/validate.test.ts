import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCallbackData,
  isValidTelegramUserId,
  isTelegramUpdate,
  parseCallbackValue,
  parseCommand,
  parsePositiveInt,
  sanitizeConfigName,
  extractCallbackTarget,
} from '../src/lib/validate.ts';
import { CB, isKnownCallback, routeCallback } from '../src/telegram/menu.ts';

test('routeCallback: static allowlist, option namespaces, garbage', () => {
  assert.deepEqual(routeCallback('menu:buy'), { kind: 'known', callback: 'menu:buy' });
  assert.deepEqual(routeCallback('ord:confirm'), { kind: 'known', callback: 'ord:confirm' });
  assert.deepEqual(routeCallback('step:back'), { kind: 'known', callback: 'step:back' });
  assert.deepEqual(routeCallback('vol:10'), { kind: 'option', namespace: 'vol', value: 10 });
  assert.deepEqual(routeCallback('dev:custom'), { kind: 'option', namespace: 'dev', value: 'custom' });
  assert.equal(routeCallback('vol:999999999999').kind, 'invalid'); // > 8 digits
  assert.equal(routeCallback('vol:0x10').kind, 'invalid');
  assert.equal(routeCallback('exec:rmi_rf_root').kind, 'invalid');
  assert.equal(routeCallback('VOL:10').kind, 'invalid');
});

test('parseCallbackValue rejects overflowing/hostile numeric payloads', () => {
  assert.equal(parseCallbackValue('12'), 12);
  assert.equal(parseCallbackValue('custom'), 'custom');
  assert.equal(parseCallbackValue('123456789'), null); // > 8 digits
  assert.equal(parseCallbackValue('-5'), null);
  assert.equal(parseCallbackValue('1e9'), null);
  assert.equal(parseCallbackValue('٠٤'), null); // non-latin digits not callback format
});

test('parsePositiveInt: persian/arabic digits, separators, bounds', () => {
  assert.equal(parsePositiveInt('۱۲'), 12);
  assert.equal(parsePositiveInt('٣٤'), 34);
  assert.equal(parsePositiveInt(' 45 '), 45);
  assert.equal(parsePositiveInt('1٬000'), 1000);
  assert.equal(parsePositiveInt('0'), 0); // allow 0; range checks reject later
  assert.equal(parsePositiveInt('-3'), null);
  assert.equal(parsePositiveInt('12.5'), null);
  assert.equal(parsePositiveInt('۱۲۳۴۵۶۷۸۹۰'), null); // 10 digits
  assert.equal(parsePositiveInt('hello'), null);
  assert.equal(parsePositiveInt(''), null);
});

test('allowlist rejects well-formed but unknown callback names (layer 2)', () => {
  assert.equal(isValidCallbackData('exec:rmi_rf_root'), true); // format ok...
  assert.equal(isKnownCallback('exec:rmi_rf_root'), false); // ...allowlist rejects
  assert.equal(isKnownCallback('menu:buy_extra'), false);
  for (const known of Object.values(CB)) {
    assert.equal(isKnownCallback(known), true, known);
  }
});

test('callback data pattern accepts known shapes', () => {
  for (const ok of ['menu:buy', 'menu:services', 'act:cancel', 'act:back_menu', 'vol:gb_10']) {
    assert.equal(isValidCallbackData(ok), true, ok);
  }
});

test('callback data pattern rejects hostile/edits payloads', () => {
  const bad: unknown[] = [
    '', 'a:b', ':buy', 'buy', 'MENU:buy', 'menu:Buy', 'menu:buy; DROP',
    'menu:buy\x00', 'menu:buyextraextraextraextraextra',
    null, undefined, 42, {}, 'menu:', 'too_long_namespace:buy',
  ];
  for (const item of bad) {
    assert.equal(isValidCallbackData(item), false, JSON.stringify(item));
  }
});

test('telegram user ids must be safe positive integers', () => {
  assert.equal(isValidTelegramUserId(1), true);
  assert.equal(isValidTelegramUserId(7654321098765432), true);
  assert.equal(isValidTelegramUserId(0), false);
  assert.equal(isValidTelegramUserId(-5), false);
  assert.equal(isValidTelegramUserId(1.5), false);
  assert.equal(isValidTelegramUserId(Number.NaN), false);
  assert.equal(isValidTelegramUserId('123' as unknown), false);
  assert.equal(isValidTelegramUserId(Number.MAX_SAFE_INTEGER + 1), false);
});

test('update shape guard', () => {
  assert.equal(isTelegramUpdate({ update_id: 1 }), true);
  assert.equal(isTelegramUpdate({ update_id: 'x' }), false);
  assert.equal(isTelegramUpdate({}), false);
  assert.equal(isTelegramUpdate(null), false);
  assert.equal(isTelegramUpdate('str'), false);
});

test('command parsing', () => {
  assert.deepEqual(parseCommand('/start'), { name: 'start', args: [] });
  assert.deepEqual(parseCommand('/Cancel now'), { name: 'cancel', args: ['now'] });
  assert.deepEqual(parseCommand('/start@telbotv2_bot'), { name: 'start', args: [] });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand('/1bad'), null);
});

test('config name sanitizer', () => {
  assert.equal(sanitizeConfigName('  my-vpn 1  '), 'my-vpn 1');
  assert.equal(sanitizeConfigName('پروفایل شخصی'), 'پروفایل شخصی');
  assert.equal(sanitizeConfigName(''), null);
  assert.equal(sanitizeConfigName('x'.repeat(65)), null);
  assert.equal(sanitizeConfigName('/etc/passwd'), null);
  assert.equal(sanitizeConfigName('line1\nline2'), null);
  assert.equal(sanitizeConfigName('tab\there'), null);
  assert.equal(sanitizeConfigName(42 as unknown), null);
});

test('callback target extraction', () => {
  assert.deepEqual(
    extractCallbackTarget({
      id: 'cb123',
      data: 'menu:buy',
      message: { message_id: 9, chat: { id: 55 } },
    }),
    { callbackQueryId: 'cb123', messageId: 9, messageChatId: 55 },
  );
  assert.deepEqual(extractCallbackTarget({ id: 'cb123' }), {
    callbackQueryId: 'cb123',
    messageId: null,
    messageChatId: null,
  });
  assert.equal(extractCallbackTarget({ id: '' }), null);
  assert.equal(extractCallbackTarget({} as never), null);
});
