import type {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
} from '../types.ts';
import { durationLabelFa, fa } from './texts.ts';

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
  MENU_WALLET: 'menu:wallet',
  MENU_INVITE: 'menu:invite',
  MENU_TICKETS: 'menu:tickets',
  MENU_ANNOUNCE_LIST: 'menu:anncs',
  ACT_CANCEL: 'act:cancel',
  ACT_BACK_MENU: 'act:back_menu',
  STEP_BACK: 'step:back',
  ORDER_CONFIRM: 'ord:confirm',
  /** Phase 7: auto-pick a config name (allowed ONLY while WAITING_CONFIG_NAME). */
  CONFIG_AUTO: 'cfg:auto',
  /** Phase 7: wallet-paid order buttons on the purchase/renewal summary. */
  PAY_WALLET_FULL: 'wlt:full',
  PAY_WALLET_PART: 'wlt:part',
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

/* ———— Phase 6: My Services + renewals ————
 * `svc:` callbacks carry a full 28-char order id (beyond the generic
 * pattern's 24-char payload cap), so they get their OWN builder/parser pair
 * exactly like `adm:` — produced ONLY here, consumed ONLY by
 * `parseServiceCallback()`, and every action re-checks ownership server-side.
 */
export type ServiceAction = 'det' | 'ref' | 'rnw';

export function serviceCallback(action: ServiceAction, orderId: string): string {
  return `svc:${action}:${orderId}`;
}

/** Services list: one detail button per service, then a menu row. */
export function servicesListKeyboard(
  entries: Array<{ orderId: string; label: string }>,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = entries.map((entry) => [
    button(entry.label, serviceCallback('det', entry.orderId)),
  ]);
  rows.push([button(fa.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}

/** Service detail: optional renewal + refresh row, service list, menu. */
export function serviceDetailKeyboard(
  orderId: string,
  opts: { canRenew: boolean },
): TelegramInlineKeyboardMarkup {
  const top: TelegramInlineKeyboardButton[] = [];
  if (opts.canRenew) top.push(button('🔁 تمدید سرویس', serviceCallback('rnw', orderId)));
  const rows: TelegramInlineKeyboardButton[][] = [
    ...(top.length > 0 ? [top] : []),
    [button('🔄 بروزرسانی وضعیت', serviceCallback('ref', orderId))],
    [button('📦 سرویس‌های من', CB.MENU_SERVICES)],
    [button(fa.backToMenu, CB.ACT_BACK_MENU)],
  ];
  return { inline_keyboard: rows };
}

/** Renewal duration: preset buttons only (labels month-aware upstream). */
export function renewalDurationKeyboard(
  presets: number[],
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = [];
    for (const value of presets.slice(i, i + 2)) {
      row.push(button(durationLabelFa(value), `dur:${value}`));
    }
    rows.push(row);
  }
  rows.push([button('❌ لغو', CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
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
      [button('💰 کیف پول', CB.MENU_WALLET), button('🤝 دعوت از دوستان', CB.MENU_INVITE)],
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
  return optionKeyboard('dur', presets, allowCustom, (v) => durationLabelFa(v));
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

/* ———— Phase 7: wallet, support tickets, announcements ————
 * `tsk:` and `ann:` carry full ULIDs, so — exactly like `adm:` and `svc:` —
 * they live in a STRICT pattern in validate.ts and are produced ONLY by the
 * builders below and parsed ONLY by parseTicketCallback/parseAnnounceCallback.
 */
export function ticketCallback(action: 'rp' | 'cl' | 'vw', ticketId: string): string {
  return `tsk:${action}:${ticketId}`;
}

/** Queue row for one live ticket: [reply][view][close] + the subject. */
export function adminTicketKeyboard(ticketId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('💬 پاسخ', ticketCallback('rp', ticketId)), button('👁 جزئیات', ticketCallback('vw', ticketId))],
      [button('✅ بستن تیکت', ticketCallback('cl', ticketId))],
    ],
  };
}

/** One pushed ticket message: quick reply + queue. */
export function adminTicketPushKeyboard(ticketId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('💬 پاسخ', ticketCallback('rp', ticketId))],
      [button('🗂 صف پشتیبانی', CB.MENU_TICKETS)],
    ],
  };
}

/** Customer-facing ticket notice: back to menu. */
export function ticketAcknowledgedKeyboard(): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [[button(fa.backToMenu, CB.ACT_BACK_MENU)]] };
}

/** Announcement confirm/receive keyboard. */
export function announceConfirmKeyboard(announcementId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('📢 ارسال', `ann:go:${announcementId}`)],
      [button('❌ انصراف', CB.ACT_CANCEL)],
    ],
  };
}

/** Announcement job control: [continue] + the /announcements-style list. */
export function announceProgressKeyboard(announcementId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('ادامه ارسال ➡️', `ann:ct:${announcementId}`)],
      [button('🗂 اطلاعیه‌ها', CB.MENU_ANNOUNCE_LIST)],
    ],
  };
}

/** Summary buttons when the wallet is usable: pay-all-from-wallet / deduct. */
export function walletPayKeyboard(partialAvailable: boolean): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [
    [button(fa.payWalletFull, CB.PAY_WALLET_FULL)],
  ];
  if (partialAvailable) {
    rows.push([button(fa.payWalletPart, CB.PAY_WALLET_PART)]);
  }
  rows.push(
    [button(fa.confirmYes, CB.ORDER_CONFIRM)],
    [button(fa.stepBack, CB.STEP_BACK), button('❌ لغو', CB.ACT_CANCEL)],
  );
  return { inline_keyboard: rows };
}

/** The config-name step: [🎲 انتخاب خودکار] directly below the prompt. */
export function configNameKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('🎲 انتخاب خودکار', CB.CONFIG_AUTO)],
      [button(fa.backToMenu, CB.ACT_BACK_MENU)],
    ],
  };
}
