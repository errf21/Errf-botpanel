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
} as const;

export type KnownCallback = (typeof CB)[keyof typeof CB];

const KNOWN_CALLBACK_VALUES: readonly string[] = Object.values(CB);

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
