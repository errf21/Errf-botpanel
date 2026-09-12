import type {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
} from '../types.ts';
import { fa } from './texts.ts';

/**
 * Callback data vocabulary. Anything not in this exact set is rejected —
 * callback data is user-editable on the wire, so it is treated as hostile.
 * (Phase 3 will add `vol:`/`dur:`/`dev:` namespaces here + in `machine.ts`.)
 */
export const CB = {
  MENU_BUY: 'menu:buy',
  MENU_SERVICES: 'menu:services',
  MENU_ORDERS: 'menu:orders',
  MENU_ACCOUNT: 'menu:account',
  MENU_SUPPORT: 'menu:support',
  ACT_CANCEL: 'act:cancel',
  ACT_BACK_MENU: 'act:back_menu',
  STEP_BACK: 'step:back',
  ORDER_CONFIRM: 'ord:confirm',
} as const;

/**
 * Admin action callbacks carry a ULID order id, so they live in their own
 * namespace with dedicated builders — values are produced ONLY by
 * `adminCallback()` below and parsed ONLY by `parseAdminCallback()`.
 */
export function adminCallback(
  action: 'ok' | 'no' | 'skip' | 'rt',
  orderId: string,
): string {
  return `adm:${action}:${orderId}`;
}

export function adminReceiptKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('✅ تأیید پرداخت', adminCallback('ok', orderId)), button('❌ رد', adminCallback('no', orderId))],
    ],
  };
}

export function adminRejectPromptKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('❌ ثبت رد بدون دلیل', adminCallback('skip', orderId))],
      [button(fa.backToMenu, CB.ACT_CANCEL)],
    ],
  };
}

export function adminQueueKeyboard(orderIds: string[]): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: orderIds.map((orderId) => [
      button('✅', adminCallback('ok', orderId)),
      button('❌', adminCallback('no', orderId)),
    ]),
  };
}

/** Phase 5: single-order retry button on provisioning-failure pushes. */
export function adminProvisionFailedKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[button('🔁 تلاش مجدد', adminCallback('rt', orderId))]],
  };
}

/** Phase 5: /failed queue — one retry button per failed order. */
export function failedQueueKeyboard(orderIds: string[]): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: orderIds.map((orderId) => [
      button(`🔁 ${orderId.slice(0, 10)}…`, adminCallback('rt', orderId)),
    ]),
  };
}

export type KnownCallback = (typeof CB)[keyof typeof CB];

const KNOWN_CALLBACK_VALUES: readonly string[] = Object.values(CB);

/** Option-namespace values are catalog-derived (validated in handlers). */
export type OptionNamespace = 'vol' | 'dur' | 'dev';

export type RouteResult =
  | { kind: 'known'; callback: KnownCallback }
  | { kind: 'option'; namespace: OptionNamespace; value: 'custom' | number }
  | { kind: 'invalid' };

const NAMESPACE_STEP: Record<OptionNamespace, 'volume' | 'duration' | 'device'> = {
  vol: 'volume',
  dur: 'duration',
  dev: 'device',
};

export function stepForNamespace(ns: OptionNamespace): 'volume' | 'duration' | 'device' {
  return NAMESPACE_STEP[ns];
}

/** Classify validated callback data against the static allowlist + option namespaces. */
export function routeCallback(data: string): RouteResult {
  if (isKnownCallback(data)) return { kind: 'known', callback: data };
  const match = /^(vol|dur|dev):(.+)$/.exec(data);
  if (match) {
    const ns = match[1] as OptionNamespace;
    const raw = match[2] ?? '';
    if (raw === 'custom') return { kind: 'option', namespace: ns, value: 'custom' };
    if (/^[0-9]{1,8}$/.test(raw)) {
      const num = Number(raw);
      if (Number.isSafeInteger(num)) {
        return { kind: 'option', namespace: ns, value: num };
      }
    }
  }
  return { kind: 'invalid' };
}

export function isKnownCallback(data: string): data is KnownCallback {
  return KNOWN_CALLBACK_VALUES.includes(data);
}

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return { text, callback_data: callbackData };
}

export function mainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('🛒 خرید سرویس', CB.MENU_BUY), button('📦 سرویس‌های من', CB.MENU_SERVICES)],
      [button('💳 سفارش‌های من', CB.MENU_ORDERS), button('👤 حساب کاربری', CB.MENU_ACCOUNT)],
      [button('🆘 پشتیبانی', CB.MENU_SUPPORT)],
    ],
  };
}

export function backToMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [[button(fa.backToMenu, CB.ACT_BACK_MENU)]] };
}

/**
 * Phase 3: catalog-driven option keyboards. Rows follow the configured preset
 * order (two per row), then a custom-input hint row and the back/cancel row.
 * Values are plain integers — validation happens server-side against the
 * freshly loaded catalog, never against what the button promised.
 */
function optionKeyboard(
  namespace: OptionNamespace,
  presets: number[],
  allowCustom: boolean,
  labelOf: (value: number) => string,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = [];
    for (const value of presets.slice(i, i + 2)) {
      row.push(button(labelOf(value), `${namespace}:${value}`));
    }
    rows.push(row);
  }
  if (allowCustom) {
    rows.push([button(fa.customVolumeLabel, `${namespace}:custom`)]);
  }
  rows.push([button(fa.stepBack, CB.STEP_BACK), button('❌ لغو', CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
}

export function volumeKeyboard(
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard('vol', presets, allowCustom, (v) => `${v} گیگ`);
}

export function durationKeyboard(
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard('dur', presets, allowCustom, (v) => `${v} روز`);
}

export function deviceKeyboard(
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard('dev', presets, allowCustom, (v) => `${v} دستگاه`);
}

export function confirmKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(fa.confirmYes, CB.ORDER_CONFIRM)],
      [button(fa.stepBack, CB.STEP_BACK), button('❌ لغو', CB.ACT_CANCEL)],
    ],
  };
}

