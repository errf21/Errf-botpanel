/**
 * Phase 12: admin pricing management (Admin-only, Persian operational surface).
 *
 * Flow: /pricing → view + field buttons → tap field (arming via admin_actions,
 * 15-min TTL) → type the new number (staged SERVER-SIDE into the arming row —
 * the value never rides on a button) → [✅ ثبت قیمت] compare-and-swap apply +
 * settings_audit insert. Every entry point (command, callback, free text)
 * re-checks ctx.isAdmin server-side; forged/misrouted/stale taps and texts
 * are inert and never write.
 */
import type { UpdateContext } from '../types.ts';
import {
  clearPendingAdminAction,
  getPendingAdminAction,
} from '../db/admin_actions.ts';
import {
  applyPricingEditCas,
  getPricingSettingsRow,
  parsePricingTarget,
  pricingArmTarget,
  pricingDocHash,
  pricingStagedTarget,
  setPendingAdminPricingAction,
  type PricingSettingsRow,
} from '../db/pricing.ts';
import { parsePricing, type PricingConfig } from '../catalog/catalog.ts';
import {
  applyPricingEdit,
  pricingFields,
  renderPricingDoc,
  type PricingFieldView,
} from '../catalog/pricingDoc.ts';
import { parsePricingAmount, parsePricingCallback } from '../lib/validate.ts';
import { pricingConfirmKeyboard, pricingMenuKeyboard } from '../telegram/menu.ts';
import { fa, formatPrice } from '../telegram/texts.ts';

const T = fa;

/** 'base' | 'gb' | 'd<months>' | 'u<count>' — one short line, no price. */
function fieldCaption(field: PricingFieldView): string {
  switch (field.kind) {
    case 'base':
      return T.adminPricingFieldBase('').trim();
    case 'gb':
      return T.adminPricingFieldGb('').trim();
    case 'duration':
      return T.adminPricingFieldMonth(field.index ?? 0, '').trim();
    case 'users':
      return T.adminPricingFieldUsers(field.index ?? 0, '').trim();
  }
}

/** The live pricing document, freshly parsed. Null when unusable. */
async function livePricing(
  db: D1Database,
): Promise<{ row: PricingSettingsRow; pricing: PricingConfig } | null> {
  const row = await getPricingSettingsRow(db);
  if (row === null) return null;
  try {
    const parsed = parsePricing(JSON.parse(row.value));
    return parsed.ok ? { row, pricing: parsed.value } : null;
  } catch {
    return null;
  }
}

/* ———— view ———— */

export async function showPricing(ctx: UpdateContext): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cmdAdminOnly);
    return;
  }
  const live = await livePricing(ctx.db);
  if (live === null) {
    await ctx.api.sendMessage(ctx.chatId, T.adminPricingUnavailable);
    return;
  }
  const { pricing } = live;
  const fields = pricingFields(pricing);
  const lines: string[] = [T.adminPricingHeader, T.adminPricingLegend];
  for (const field of fields) {
    const price =
      field.kind === 'users' && field.index === 1 && field.value === 0
        ? T.adminPricingUserIncluded
        : formatPrice(field.value, pricing.currency);
    lines.push(
      field.kind === 'base'
        ? T.adminPricingFieldBase(price)
        : field.kind === 'gb'
          ? T.adminPricingFieldGb(price)
          : field.kind === 'duration'
            ? T.adminPricingFieldMonth(field.index ?? 0, price)
            : T.adminPricingFieldUsers(field.index ?? 0, price),
    );
  }
  if (live.row.updated_by !== null) {
    lines.push(`آخرین ویرایش: ${live.row.updated_by} — ${live.row.updated_at.slice(0, 16)}`);
  }
  lines.push(T.adminPricingHint);
  await ctx.api.sendMessage(
    ctx.chatId,
    lines.join('\n'),
    pricingMenuKeyboard(
      fields.map((field) => {
        const price =
          field.kind === 'users' && field.index === 1 && field.value === 0
            ? T.adminPricingUserIncluded
            : formatPrice(field.value, pricing.currency);
        const glyph =
          field.kind === 'base'
            ? '🧱'
            : field.kind === 'gb'
              ? '⚖️'
              : field.kind === 'duration'
                ? `📅${field.index}م`
                : `👤${field.index}`;
        return { label: `${glyph} ${price}`.slice(0, 64), token: field.token };
      }),
    ),
  );
}

/* ———— callbacks (prc:menu / prc:e_<token> / prc:ok / prc:no) ———— */

export async function handlePricingCallback(
  ctx: UpdateContext,
  data: string,
  callbackQueryId: string,
): Promise<void> {
  const parsed = parsePricingCallback(data);
  if (!parsed || !ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice, true);
    return;
  }
  switch (parsed.action) {
    case 'menu':
      await ctx.api.answerCallbackQuery(callbackQueryId);
      await showPricing(ctx);
      return;
    case 'no':
      await clearPendingAdminAction(ctx.db, ctx.actor.id);
      await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingCancelled);
      return;
    case 'edit':
      await armPricingField(ctx, parsed.token, callbackQueryId);
      return;
    case 'ok':
      await confirmPricingEdit(ctx, callbackQueryId);
      return;
  }
}

async function armPricingField(
  ctx: UpdateContext,
  token: string,
  callbackQueryId: string,
): Promise<void> {
  const live = await livePricing(ctx.db);
  if (live === null) {
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingUnavailable, true);
    return;
  }
  const field = pricingFields(live.pricing).find((c) => c.token === token);
  if (!field) {
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingFieldGone, true);
    return;
  }
  await setPendingAdminPricingAction(ctx.db, ctx.actor.id, pricingArmTarget(token));
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await ctx.api.sendMessage(
    ctx.chatId,
    T.adminPricingPrompt(
      fieldCaption(field),
      formatPrice(field.value, live.pricing.currency),
    ),
  );
}

async function confirmPricingEdit(
  ctx: UpdateContext,
  callbackQueryId: string,
): Promise<void> {
  const pending = await getPendingAdminAction(ctx.db, ctx.actor.id);
  const stage =
    pending !== null && pending.action === 'pricing'
      ? parsePricingTarget(pending.target_id)
      : null;
  if (stage === null || stage.amount === null || stage.docHash === null) {
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingStale, true);
    await clearPendingAdminAction(ctx.db, ctx.actor.id);
    return;
  }
  const live = await livePricing(ctx.db);
  if (live === null) {
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingUnavailable, true);
    return;
  }
  // The document moved under this edit while the value was typed/staged:
  // refuse instead of silently overwriting the newer state.
  if (pricingDocHash(live.row.value) !== stage.docHash) {
    await clearPendingAdminAction(ctx.db, ctx.actor.id);
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingConflict, true);
    await showPricing(ctx);
    return;
  }
  const edit = applyPricingEdit(live.pricing, stage.token, stage.amount);
  if (!edit.ok) {
    await ctx.api.answerCallbackQuery(
      callbackQueryId,
      edit.error === 'field_unknown' ? T.adminPricingFieldGone : T.adminPricingAmountRejected,
      true,
    );
    return;
  }
  // Value-only edits can never break ladder coverage (the key sets are
  // untouched), and the result round-tripped through the real parser.
  const outcome = await applyPricingEditCas(ctx.db, {
    oldJson: live.row.value,
    newJson: renderPricingDoc(edit.updated),
    adminUserId: ctx.actor.id,
    fieldToken: stage.token,
  });
  await clearPendingAdminAction(ctx.db, ctx.actor.id);
  if (outcome !== 'applied') {
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingConflict, true);
    await showPricing(ctx);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId, T.adminPricingConfirmToast);
  await showPricing(ctx);
}

/* ———— free text while armed (handleText admin intercept) ———— */

export async function completeArmedPricingAction(
  ctx: UpdateContext,
  pendingTargetId: string | null,
  text: string,
): Promise<void> {
  const stage = parsePricingTarget(pendingTargetId);
  if (stage === null) {
    await clearPendingAdminAction(ctx.db, ctx.actor.id);
    await ctx.api.sendMessage(ctx.chatId, T.adminPricingStale);
    return;
  }
  const amount = parsePricingAmount(text);
  if (amount === null) {
    // Garbage keeps the arming (and any staged value) alive — wallet precedent.
    await ctx.api.sendMessage(
      ctx.chatId,
      stage.amount === null
        ? T.adminPricingAmountInvalid
        : T.adminPricingAmountInvalid + '\n' + T.adminPricingHint,
    );
    return;
  }
  const live = await livePricing(ctx.db);
  if (live === null) {
    await ctx.api.sendMessage(ctx.chatId, T.adminPricingUnavailable);
    return;
  }
  const field = pricingFields(live.pricing).find((c) => c.token === stage.token);
  if (!field) {
    await clearPendingAdminAction(ctx.db, ctx.actor.id);
    await ctx.api.sendMessage(ctx.chatId, T.adminPricingFieldGone);
    return;
  }
  const edit = applyPricingEdit(live.pricing, stage.token, amount);
  if (!edit.ok) {
    await ctx.api.sendMessage(
      ctx.chatId,
      edit.error === 'field_unknown' ? T.adminPricingFieldGone : T.adminPricingAmountRejected,
    );
    return;
  }
  // Valid number → (re-)stage with the fingerprint of the live document the
  // admin typed against; application still requires the button tap.
  await setPendingAdminPricingAction(
    ctx.db,
    ctx.actor.id,
    pricingStagedTarget(stage.token, amount, pricingDocHash(live.row.value)),
  );
  await ctx.api.sendMessage(
    ctx.chatId,
    T.adminPricingStaged(fieldCaption(field), formatPrice(amount, live.pricing.currency)),
    pricingConfirmKeyboard(),
  );
}
