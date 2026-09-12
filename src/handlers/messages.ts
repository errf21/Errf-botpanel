import type { UpdateContext } from '../types.ts';
import { sanitizeConfigName } from '../lib/validate.ts';
import { backToMenuKeyboard, mainMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getSession, setSession } from '../db/states.ts';
import { acceptsTextInput, reduce } from '../state/machine.ts';

/**
 * Plain-text messages, routed through the state machine.
 * Phase 2 consumes text only in WAITING_CONFIG_NAME; everywhere else text
 * is politely ignored (state preserved) until later phases register steps.
 */
export async function handleText(
  ctx: UpdateContext,
  text: string,
): Promise<void> {
  const session = await getSession(ctx.db, ctx.customerId);

  if (!acceptsTextInput(session.state)) {
    await ctx.api.sendMessage(ctx.chatId, fa.idleInputHint, mainMenuKeyboard());
    return;
  }

  // WAITING_CONFIG_NAME → validate → persist draft + advance via machine
  const name = sanitizeConfigName(text);
  if (!name) {
    await ctx.api.sendMessage(ctx.chatId, fa.configNameInvalid, backToMenuKeyboard());
    return;
  }

  const next = reduce(session.state, 'name_accepted'); // → WAITING_VOLUME
  await setSession(ctx.db, ctx.customerId, next, {
    ...session.data,
    config_name: name,
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    `${fa.configNameSaved(name)}\n${fa.buyFlowSoon}`,
    backToMenuKeyboard(),
  );
}
