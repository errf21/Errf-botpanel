import type { UpdateContext } from '../types.ts';
import { parsePositiveInt, sanitizeConfigName } from '../lib/validate.ts';
import { backToMenuKeyboard, mainMenuKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { getSession, setSession } from '../db/states.ts';
import { acceptsTextInput, reduce } from '../state/machine.ts';
import { loadCatalog, type StepKind } from '../catalog/catalog.ts';
import {
  STEP_EXPECTED_STATE,
  applyStepChoice,
  sendSummary,
  stepView,
} from './purchase.ts';

/**
 * Plain-text messages, routed through the state machine.
 * Accepted where `acceptsTextInput(state)`:
 *  - WAITING_CONFIG_NAME   → sanitized free-text name
 *  - WAITING_VOLUME / …    → a custom numeric ("دلخواه") value for that step
 * Everything else is politely ignored (state preserved).
 */
export async function handleText(ctx: UpdateContext, text: string): Promise<void> {
  const session = await getSession(ctx.db, ctx.customerId);

  if (!acceptsTextInput(session.state)) {
    if (session.state === 'WAITING_ORDER_CONFIRMATION') {
      // mid-summary typing: re-show summary without changing anything
      const loaded = await loadCatalog(ctx.db);
      if (loaded.ok) await sendSummary(ctx, session, loaded.catalog);
      else await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      return;
    }
    if (session.state === 'WAITING_PAYMENT_RECEIPT') {
      await ctx.api.sendMessage(ctx.chatId, fa.paymentWaitNotice, backToMenuKeyboard());
      return;
    }
    await ctx.api.sendMessage(ctx.chatId, fa.idleInputHint, mainMenuKeyboard());
    return;
  }

  // Numeric purchase steps (custom volume/duration/device via text)
  const numericKind = numericStepFor(session.state);
  if (numericKind) {
    const loaded = await loadCatalog(ctx.db);
    if (!loaded.ok) {
      await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
      return;
    }
    const value = parsePositiveInt(text);
    if (value === null) {
      await ctx.api.sendMessage(ctx.chatId, fa.rejectedNotWhole, backToMenuKeyboard());
      return;
    }
    await applyStepChoice(ctx, session, loaded.catalog, numericKind, value);
    return;
  }

  // WAITING_CONFIG_NAME
  const name = sanitizeConfigName(text);
  if (!name) {
    await ctx.api.sendMessage(ctx.chatId, fa.configNameInvalid, backToMenuKeyboard());
    return;
  }

  const next = reduce(session.state, 'name_accepted'); // → WAITING_VOLUME
  await setSession(ctx.db, ctx.customerId, next, { ...session.data, config_name: name });

  const loaded = await loadCatalog(ctx.db);
  if (!loaded.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.catalogUnavailable, backToMenuKeyboard());
    return;
  }
  await ctx.api.sendMessage(ctx.chatId, fa.configNameSaved(name), backToMenuKeyboard());
  const view = stepView(next, loaded.catalog);
  if (view) await ctx.api.sendMessage(ctx.chatId, view.text, view.keyboard);
}

function numericStepFor(state: string): StepKind | null {
  for (const [kind, expected] of Object.entries(STEP_EXPECTED_STATE) as [StepKind, string][]) {
    if (state === expected) return kind;
  }
  return null;
}
