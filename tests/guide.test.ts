/**
 * Phase 11 unit tests: the connection-guide registry itself.
 * No DB, no network — ordering, the closed callback vocabulary, the
 * live-verified official URL set, label/bundle integrity and keyboard shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fa } from '../src/telegram/texts.ts';
import { en } from '../src/telegram/texts.en.ts';
import { CB } from '../src/telegram/menu.ts';
import { isKnownCallback, routeCallback } from '../src/telegram/menu.ts';
import { isValidCallbackData } from '../src/lib/validate.ts';
import {
  GUIDE_PLATFORMS,
  findGuideApp,
  findGuidePlatform,
  guideAppKeyboard,
  guideCallbackValues,
  guidePickerKeyboard,
  guidePlatformKeyboard,
} from '../src/telegram/guide.ts';

const PERSIAN = /[\u0600-\u06FF\u200C\u200D]/;

/** The exact official URL set, pinned literal (live-verified at build time). */
const PINNED_URLS = [
  'https://play.google.com/store/apps/details?id=llc.itdev.incy',
  'https://play.google.com/store/apps/details?id=com.v2raytun.android',
  'https://github.com/v2RayTun',
  'https://github.com/2dust/v2rayNG',
  'https://github.com/2dust/v2rayNG/releases',
  'https://apps.apple.com/app/id6446814690',
  'https://apps.apple.com/app/id6450534064',
  'https://github.com/throneproj/Throne',
  'https://github.com/throneproj/Throne/releases',
] as const;

test('platforms and app picks follow the agreed official order', () => {
  assert.deepEqual(GUIDE_PLATFORMS.map((p) => p.callback), [
    CB.GUIDE_ANDROID, CB.GUIDE_IOS, CB.GUIDE_WINDOWS,
  ]);
  assert.deepEqual(GUIDE_PLATFORMS.map((p) => p.label), ['🤖 Android', '🍎 iOS', '🪟 Windows']);
  assert.deepEqual(GUIDE_PLATFORMS.map((p) => p.apps.map((a) => a.name)), [
    ['incy', 'v2RayTun', 'v2rayNG'],
    ['V2Box', 'Streisand'],
    ['Throne'],
  ]);
});

test('every guide callback is wired into the closed allowlist and passes the wire validator', () => {
  const values = guideCallbackValues();
  const unique = new Set(values);
  assert.equal(unique.size, 3 + 6, 'three platforms + six apps, no duplicates');
  for (const value of values) {
    assert.equal(isValidCallbackData(value), true, `pattern: ${value}`);
    assert.equal(isKnownCallback(value), true, `allowlist: ${value}`);
    assert.deepEqual(routeCallback(value), { kind: 'known', callback: value });
  }
});

test('registries only reference official domains it was verified against', () => {
  const urls = GUIDE_PLATFORMS.flatMap((p) => p.apps.flatMap((a) => a.links.map((l) => l.url)));
  assert.deepEqual([...urls].sort(), [...PINNED_URLS].sort(), 'the pinned URL set drifted');
  for (const url of urls) {
    assert.equal(url.startsWith('https://'), true, url);
    const host = new URL(url).host;
    assert.ok(
      host === 'play.google.com' || host === 'github.com' || host === 'apps.apple.com',
      `unofficial host: ${host}`,
    );
    if (host === 'github.com') {
      const owner = new URL(url).pathname.split('/')[1] ?? '';
      assert.ok(
        owner === 'v2RayTun' || owner === '2dust' || owner === 'throneproj',
        `unofficial owner: ${owner}`,
      );
    }
  }
});

test('v2rayNG carries NO Google Play button (Play link failed live verification)', () => {
  const ng = findGuideApp(CB.GUIDE_AND_NG);
  assert.ok(ng);
  assert.equal(ng.app.links.some((l) => l.url.includes('play.google.com')), false);
  assert.deepEqual(ng.app.links.map((l) => l.url), [
    'https://github.com/2dust/v2rayNG/releases',
    'https://github.com/2dust/v2rayNG',
  ]);
});

test('incy is the FIRST Android app and carries ONLY its verified Google Play link', () => {
  assert.deepEqual(GUIDE_PLATFORMS[0]!.apps.map((a) => a.name), ['incy', 'v2RayTun', 'v2rayNG']);
  const incy = findGuideApp(CB.GUIDE_AND_INCY);
  assert.ok(incy, 'incy is registered');
  assert.deepEqual(incy.app.links.map((l) => l.url), [
    'https://play.google.com/store/apps/details?id=llc.itdev.incy',
  ]);
  const incyKb = guideAppKeyboard(incy, fa).inline_keyboard;
  assert.deepEqual(incyKb[0]?.map((b) => [b.text, b.url]), [
    ['📥 Google Play', 'https://play.google.com/store/apps/details?id=llc.itdev.incy'],
  ]);
});

test('exact-match lookup rejects anything the registry does not mint', () => {
  assert.equal(findGuidePlatform(CB.GUIDE_AND_TUN), null, 'an app is not a platform');
  assert.equal(findGuideApp(CB.GUIDE_ANDROID), null, 'a platform is not an app');
  assert.equal(findGuidePlatform('gud:hack'), null);
  assert.equal(findGuideApp('menu:buy'), null);
});

test('step bodies render from both bundles: non-empty, own-script, no raw markup', () => {
  for (const platform of GUIDE_PLATFORMS) {
    assert.ok(PERSIAN.test(platform.intro(fa)), 'fa intro must be Persian');
    assert.ok(platform.intro(en).length > 40 && !PERSIAN.test(platform.intro(en)), 'en intro');
  }
  for (const platform of GUIDE_PLATFORMS) {
    for (const app of platform.apps) {
      for (const [t, name, persian] of [[fa, 'fa', true], [en, 'en', false]] as const) {
        const body = app.steps(t);
        assert.ok(body.length > 100, `${app.name} ${name} body too short`);
        assert.equal(body.includes('<'), false, 'raw markup in a plain-text body');
        assert.equal(body.includes('>'), false);
        assert.equal(PERSIAN.test(body), persian, `${app.name} ${name} script`);
      }
      assert.equal(app.steps(en).includes(app.name), true, 'en body names its app');
    }
  }
});

test('brand labels are byte-identical across bundles (locale-fixed by design)', () => {
  for (const key of ['guideBtnPlay', 'guideBtnStore', 'guideBtnGithub', 'guideBtnReleases'] as const) {
    assert.equal(en[key], fa[key], key);
  }
  assert.equal(fa.guideHowToApp('Throne'), '📖 راهنمای اتصال — Throne');
  assert.equal(en.guideHowToApp('Throne'), '📖 How to connect — Throne');
});

test('keyboard shapes: picker rows, per-platform 📖 order, single-app nav rules', () => {
  const picker = guidePickerKeyboard(fa).inline_keyboard;
  assert.deepEqual(picker.map((r) => r.map((b) => b.callback_data)), [
    [CB.GUIDE_ANDROID, CB.GUIDE_IOS],
    [CB.GUIDE_WINDOWS],
    [CB.ACT_BACK_MENU],
  ]);

  const android = GUIDE_PLATFORMS[0]!;
  const platformKb = guidePlatformKeyboard(android, fa).inline_keyboard;
  assert.equal(platformKb[0]?.[0]?.text, '📖 راهنمای اتصال — incy', 'app order: incy first');
  assert.equal(platformKb[1]?.[0]?.text, '📖 راهنمای اتصال — v2RayTun');
  assert.equal(platformKb[2]?.[0]?.text, '📖 راهنمای اتصال — v2rayNG');
  assert.deepEqual(platformKb.at(-2)?.map((b) => b.callback_data), [CB.GUIDE_IOS, CB.GUIDE_WINDOWS]);
  assert.deepEqual(platformKb.at(-1)?.map((b) => b.callback_data ?? b.url), [CB.ACT_BACK_MENU]);

  const tun = findGuideApp(CB.GUIDE_AND_TUN)!;
  const appKb = guideAppKeyboard(tun, fa).inline_keyboard;
  assert.deepEqual(appKb[0]?.map((b) => b.url), [
    'https://play.google.com/store/apps/details?id=com.v2raytun.android',
    'https://github.com/v2RayTun',
  ]);
  assert.equal(appKb.flat().some((b) => b.text === fa.guideOtherApps), true);
  assert.equal(appKb[1]?.[0]?.callback_data, CB.GUIDE_ANDROID, 'other apps re-opens screen 2');
  assert.equal(appKb.at(-1)?.[0]?.callback_data, CB.ACT_BACK_MENU);

  // Windows: single-app platforms show NO "other apps" row at all.
  const windows = GUIDE_PLATFORMS[2]!;
  const throne = findGuideApp(CB.GUIDE_WIN_THRONE)!;
  const winKb = guideAppKeyboard(throne, fa).inline_keyboard;
  assert.equal(winKb.length, 2, 'url row + menu row only');
  assert.equal(winKb.map((r) => r.length).join(), '2,1');
  assert.deepEqual(guidePlatformKeyboard(windows, fa).inline_keyboard.map((r) => r.length), [1, 2, 1]);
});
