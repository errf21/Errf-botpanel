/**
 * Phase 13: admin sales stop/resume surface (Admin-only, Persian operational UI).
 *
 * Flow: /sales → view (state + toggle button) → tap → CAS toggle + settings_audit
 * row → view re-rendered. The value is a boolean switch, so there is no staged
 * arm/confirm round-trip like pricing: the TOGGLE ITSELF is the two-step guard
 * (the operator reads the current state on the bubble and taps the one button
 * that changes it), while the compare-and-swap protects against two admins
 * toggling concurrently (the loser sees 'conflict' and the fresh state, never
 * a silent overwrite).
 *
 * Every entry point (command, callback) re-checks ctx.isAdmin server-side;
 * forged/misrouted/stale taps are inert and never write. Fail-open lives in
 * catalog/sales.ts: ONLY an explicit stopped:true blocks commercial creation.
 */
import type { UpdateContext } from '../types.ts';
import {
  applySalesToggleCas,
  ensureSalesRow,
  getSalesSettingsRow,
  salesDoc,
} from '../db/sales.ts';
import { loadSalesState } from '../catalog/sales.ts';
import { parseSalesCallback } from '../lib/validate.ts';
import { salesKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';

const T = fa;

/** Render the current switch state (admin-only surface — always `fa`). */
export async function showSalesStatus(ctx: UpdateContext): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cmdAdminOnly);
    return;
  }
  await renderSalesView(ctx);
}

async function renderSalesView(ctx: UpdateContext): Promise<void> {
  const state = await loadSalesState(ctx.db);
  const row = await getSalesSettingsRow(ctx.db);
  const lines: string[] = [];
  lines.push(state.config.stopped ? T.adminSalesStateStopped : T.adminSalesStateActive);
  if (state.malformed) lines.push(T.adminSalesMalformed);
  if (row && row.updated_by) {
    lines.push(T.adminSalesUpdated(`${row.updated_by} — ${row.updated_at.slice(0, 16)}`));
  }
  lines.push(T.adminSalesHint);
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), salesKeyboard(state.config.stopped));
}

/**
 * Handles `sal:view` / `sal:stop` / `sal:start` (only ever data that already
 * passed isValidCallbackData + parseSalesCallback + the isAdmin gate).
 */
export async function handleSalesCallback(
  ctx: UpdateContext,
  data: string,
  callbackQueryId: string,
): Promise<void> {
  const action = parseSalesCallback(data);
  if (action === null || !ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice, true);
    return;
  }
  if (action === 'view') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await renderSalesView(ctx);
    return;
  }
  await toggleSales(ctx, action === 'stop', callbackQueryId);
}

async function toggleSales(
  ctx: UpdateContext,
  wantStopped: boolean,
  callbackQueryId: string,
): Promise<void> {
  const current = await loadSalesState(ctx.db);
  if (!current.malformed && current.config.stopped === wantStopped) {
    // Idempotent tap (a replayed button on a superseded bubble): the state is
    // ALREADY what was asked — answer, re-render, and write NOTHING.
    await ctx.api.answerCallbackQuery(
      callbackQueryId,
      wantStopped ? T.adminSalesStoppedToast : T.adminSalesStartedToast,
    );
  } else {
    await ensureSalesRow(ctx.db);
    const row = await getSalesSettingsRow(ctx.db);
    // The raw stored string is the CAS token — even a malformed document is
    // replaced atomically and never stomps a newer winner.
    const outcome =
      row === null
        ? 'missing'
        : await applySalesToggleCas(ctx.db, {
            oldJson: row.value,
            newJson: salesDoc(wantStopped),
            adminUserId: ctx.actor.id,
            action: wantStopped ? 'stop' : 'start',
          });
    if (outcome === 'conflict') {
      // Another admin moved it this instant: show the winner's state instead
      // of silently overwriting the newer document.
      await ctx.api.answerCallbackQuery(callbackQueryId, T.adminSalesConflict, true);
    } else if (outcome === 'applied') {
      await ctx.api.answerCallbackQuery(
        callbackQueryId,
        wantStopped ? T.adminSalesStoppedToast : T.adminSalesStartedToast,
      );
    } else {
      // 'missing' (row vanished mid-flight, or could not be seeded): never
      // claim success — the re-render below shows the TRUE current state.
      await ctx.api.answerCallbackQuery(callbackQueryId, T.adminSalesSaveFailed, true);
    }
  }
  await renderSalesView(ctx);
}
