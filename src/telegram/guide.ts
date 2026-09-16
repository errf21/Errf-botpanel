/**
 * Phase 11: the connection guide — a static, stateless content registry.
 *
 * One source of truth for the platforms (Android → iOS → Windows), their
 * ordered app picks, the official links and the keyboard builders. There is
 * no DB, no session and no per-user progress: every screen is re-derived
 * from this file, so ANY tap on ANY (even stale) guide button is idempotent
 * and touches nothing outside this module.
 *
 * EVERY URL below was LIVE-VERIFIED at implementation time against the
 * project's own official source (store listing / repository / project site):
 *  - v2RayTun  — Google Play listing (dev DATABRIDGES TECHNOLOGIES LTD,
 *                pkg com.v2raytun.android) + the official GitHub org.
 *  - v2rayNG   — official GitHub repo + its Releases page (the README's own
 *                download location). NO Google Play button: the listing
 *                could not be verified — omitted by policy, never guessed.
 *  - NekoBox   — official GitHub repo MatsuriDayo/NekoBoxForAndroid + its
 *                Releases page. NO Google Play button: the README states the
 *                Play listing is third-party/fake since May 2024 — omitted
 *                by policy, never guessed.
 *  - V2Box / Streisand — App Store IDs confirmed via Apple's lookup API;
 *                both proprietary, so no GitHub button exists.
 *  - Throne    — official GitHub org repo (throneproj/Throne) + Releases.
 * Never add a URL that was not verified against the project's own page.
 */
import type {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
} from '../types.ts';
import type { Texts } from './texts.ts';
import { CB } from './menu.ts';

/* ———— wire helpers (same private pattern as menu.ts) ———— */

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return { text, callback_data: callbackData };
}

function urlButton(text: string, url: string): TelegramInlineKeyboardButton {
  return { text, url };
}

/* ———— registry shapes ———— */

export interface GuideLink {
  /** Button label — locale-fixed store name, read from the active bundle. */
  label: (t: Texts) => string;
  url: string;
}

export interface GuideApp {
  /** Exact-match callback from the closed CB allowlist. */
  callback: string;
  /** Product name — locale-fixed in both bundles. */
  name: string;
  /** The step-by-step body (reviewed copy), localized per bundle. */
  steps: (t: Texts) => string;
  /** Official download links, in tap order. */
  links: readonly GuideLink[];
}

export interface GuidePlatform {
  /** Exact-match callback from the closed CB allowlist. */
  callback: string;
  /** Platform button label — locale-fixed. */
  label: string;
  intro: (t: Texts) => string;
  apps: readonly GuideApp[];
}

/* ———— verified official links ———— */

const LINK_PLAY_V2RAYTUN: GuideLink = {
  label: (t) => t.guideBtnPlay,
  url: 'https://play.google.com/store/apps/details?id=com.v2raytun.android',
};
const LINK_GITHUB_V2RAYTUN: GuideLink = {
  label: (t) => t.guideBtnGithub,
  url: 'https://github.com/v2RayTun',
};
const LINK_RELEASES_V2RAYNG: GuideLink = {
  label: (t) => t.guideBtnReleases,
  url: 'https://github.com/2dust/v2rayNG/releases',
};
const LINK_GITHUB_V2RAYNG: GuideLink = {
  label: (t) => t.guideBtnGithub,
  url: 'https://github.com/2dust/v2rayNG',
};
const LINK_RELEASES_NEKOBOX: GuideLink = {
  label: (t) => t.guideBtnReleases,
  url: 'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases',
};
const LINK_GITHUB_NEKOBOX: GuideLink = {
  label: (t) => t.guideBtnGithub,
  url: 'https://github.com/MatsuriDayo/NekoBoxForAndroid',
};
const LINK_APPSTORE_V2BOX: GuideLink = {
  label: (t) => t.guideBtnStore,
  url: 'https://apps.apple.com/app/id6446814690',
};
const LINK_APPSTORE_STREISAND: GuideLink = {
  label: (t) => t.guideBtnStore,
  url: 'https://apps.apple.com/app/id6450534064',
};
const LINK_RELEASES_THRONE: GuideLink = {
  label: (t) => t.guideBtnReleases,
  url: 'https://github.com/throneproj/Throne/releases',
};
const LINK_GITHUB_THRONE: GuideLink = {
  label: (t) => t.guideBtnGithub,
  url: 'https://github.com/throneproj/Throne',
};

export const GUIDE_PLATFORMS: readonly GuidePlatform[] = [
  {
    callback: CB.GUIDE_ANDROID,
    label: '🤖 Android',
    intro: (t) => t.guidePlatformAndroid,
    apps: [
      {
        callback: CB.GUIDE_AND_NG,
        name: 'v2rayNG',
        steps: (t) => t.guideStepsNg,
        links: [LINK_RELEASES_V2RAYNG, LINK_GITHUB_V2RAYNG],
      },
      {
        callback: CB.GUIDE_AND_NEKO,
        name: 'NekoBox',
        steps: (t) => t.guideStepsNeko,
        links: [LINK_RELEASES_NEKOBOX, LINK_GITHUB_NEKOBOX],
      },
      {
        callback: CB.GUIDE_AND_TUN,
        name: 'v2RayTun',
        steps: (t) => t.guideStepsTun,
        links: [LINK_PLAY_V2RAYTUN, LINK_GITHUB_V2RAYTUN],
      },
    ],
  },
  {
    callback: CB.GUIDE_IOS,
    label: '🍎 iOS',
    intro: (t) => t.guidePlatformIos,
    apps: [
      {
        callback: CB.GUIDE_IOS_V2BOX,
        name: 'V2Box',
        steps: (t) => t.guideStepsV2box,
        links: [LINK_APPSTORE_V2BOX],
      },
      {
        callback: CB.GUIDE_IOS_STREISAND,
        name: 'Streisand',
        steps: (t) => t.guideStepsStreisand,
        links: [LINK_APPSTORE_STREISAND],
      },
    ],
  },
  {
    callback: CB.GUIDE_WINDOWS,
    label: '🪟 Windows',
    intro: (t) => t.guidePlatformWindows,
    apps: [
      {
        callback: CB.GUIDE_WIN_THRONE,
        name: 'Throne',
        steps: (t) => t.guideStepsThrone,
        links: [LINK_RELEASES_THRONE, LINK_GITHUB_THRONE],
      },
    ],
  },
] as const;

/* ———— exact-match lookup (hostile data simply finds nothing) ———— */

export function findGuidePlatform(callback: string): GuidePlatform | null {
  return GUIDE_PLATFORMS.find((platform) => platform.callback === callback) ?? null;
}

export interface GuideAppEntry {
  app: GuideApp;
  platform: GuidePlatform;
}

export function findGuideApp(callback: string): GuideAppEntry | null {
  for (const platform of GUIDE_PLATFORMS) {
    for (const app of platform.apps) {
      if (app.callback === callback) return { app, platform };
    }
  }
  return null;
}

/** Every guide navigation value — pinned by tests to the CB allowlist. */
export function guideCallbackValues(): string[] {
  return GUIDE_PLATFORMS.flatMap((platform) => [
    platform.callback,
    ...platform.apps.map((app) => app.callback),
  ]);
}

/* ———— keyboards ———— */

/** Screen 1: platform picker (also the reopen target of an intro tap). */
export function guidePickerKeyboard(t: Texts): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < GUIDE_PLATFORMS.length; i += 2) {
    rows.push(GUIDE_PLATFORMS.slice(i, i + 2).map((p) => button(p.label, p.callback)));
  }
  rows.push([button(t.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}

/** Screen 2: the platform's ordered apps (📖 per app), other platforms, menu. */
export function guidePlatformKeyboard(
  platform: GuidePlatform,
  t: Texts,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = platform.apps.map((app) => [
    button(t.guideHowToApp(app.name), app.callback),
  ]);
  const others = GUIDE_PLATFORMS.filter((p) => p.callback !== platform.callback);
  if (others.length > 0) {
    rows.push(others.map((p) => button(p.label, p.callback)));
  }
  rows.push([button(t.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}

/** Screen 3: official links for one app, same-platform app switch, menu. */
export function guideAppKeyboard(entry: GuideAppEntry, t: Texts): TelegramInlineKeyboardMarkup {
  const { app, platform } = entry;
  const rows: TelegramInlineKeyboardButton[][] = [
    app.links.map((link) => urlButton(link.label(t), link.url)),
  ];
  if (platform.apps.length > 1) {
    rows.push([button(t.guideOtherApps, platform.callback)]);
  }
  rows.push([button(t.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}
