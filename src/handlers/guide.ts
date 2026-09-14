/**
 * Phase 11: the connection-guide handler.
 *
 * Deliberately the dumbest flow in the bot: every `gud:*` tap answers with a
 * fresh bubble re-rendered from the static registry (`telegram/guide.ts`) in
 * the actor's CURRENT language. The conversation state machine is never read,
 * never written — a tap while any flow is busy is harmless (exactly like the
 * Phase 10 `lang:` taps, which are also handled before the session read).
 * Unknown `gud:` values (e.g. a forged payload) get the standard neutral
 * toast and zero side effects.
 */
import type { UpdateContext } from '../types.ts';
import {
  findGuideApp,
  findGuidePlatform,
  guideAppKeyboard,
  guidePickerKeyboard,
  guidePlatformKeyboard,
} from '../telegram/guide.ts';

/** Main-menu shortcut (both transports): intro + platform picker. */
export async function openGuide(ctx: UpdateContext): Promise<void> {
  await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.guideIntro, guidePickerKeyboard(ctx.ui.t));
}

/** One `gud:*` tap → its screen. Unknown values stay inside this namespace. */
export async function handleGuideCallback(
  ctx: UpdateContext,
  data: string,
  callbackQueryId: string,
): Promise<void> {
  const t = ctx.ui.t;
  const platform = findGuidePlatform(data);
  if (platform !== null) {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(ctx.chatId, platform.intro(t), guidePlatformKeyboard(platform, t));
    return;
  }
  const entry = findGuideApp(data);
  if (entry !== null) {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(ctx.chatId, entry.app.steps(t), guideAppKeyboard(entry, t));
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId, t.invalidChoice, true);
}
