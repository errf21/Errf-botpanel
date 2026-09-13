/**
 * Phase 10: the language selector. Taps arrive through the validated known-
 * callback vocabulary (`lang:fa` / `lang:en`) or the fixed bilingual menu
 * button; the ONLY write is the actor's own explicit preference, keyed on
 * the dispatcher-verified Telegram id. Nothing else changes: the conversation
 * state machine is language-agnostic, so switching mid-flow is safe — the
 * confirmation restores whichever keyboard fits the CURRENT state.
 */
import type { TelegramReplyMarkup, UpdateContext } from '../types.ts';
import type { Locale, Ui } from '../telegram/i18n.ts';
import { uiFor } from '../telegram/i18n.ts';
import { setCustomerLanguage } from '../db/customers.ts';
import { getSession } from '../db/states.ts';
import {
  backToMenuKeyboard,
  composingKeyboard,
  configNameKeyboard,
  languagePickerKeyboard,
  mainMenuKeyboard,
} from '../telegram/menu.ts';

/** `menu:lang` — present the picker in the actor's current language. */
export async function showLanguageChoice(ctx: UpdateContext): Promise<void> {
  await ctx.api.sendMessage(
    ctx.chatId,
    ctx.ui.t.languageIntro,
    languagePickerKeyboard(ctx.ui),
  );
}

/**
 * `lang:fa` / `lang:en` — persist the choice and answer IN THE NEW LANGUAGE.
 * Idempotent by nature (a repeat tap just re-confirms); a lost write is
 * safe: nothing else changed, a re-tap targets the same value.
 */
export async function applyLanguageChoice(ctx: UpdateContext, locale: Locale): Promise<void> {
  await setCustomerLanguage(ctx.db, ctx.actor.id, locale);
  const ui = uiFor(locale);
  const keyboard = await currentKeyboard(ctx, ui);
  await ctx.api.sendMessage(ctx.chatId, ui.t.languageSet, keyboard);
}

/** The keyboard the conversation was showing — re-rendered in the new bundle. */
async function currentKeyboard(ctx: UpdateContext, ui: Ui): Promise<TelegramReplyMarkup> {
  const session = await getSession(ctx.db, ctx.customerId).catch(() => null);
  switch (session?.state) {
    case 'WAITING_CONFIG_NAME':
      return configNameKeyboard(ui);
    case 'WAITING_SUPPORT_MESSAGE':
    case 'WAITING_ANNOUNCE_TEXT':
      return composingKeyboard(ui);
    case undefined:
    case 'IDLE':
      return mainMenuKeyboard(ui);
    default:
      return backToMenuKeyboard(ui);
  }
}
