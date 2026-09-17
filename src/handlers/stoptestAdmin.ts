/**
 * Phase 23: admin free-test stop/resume surface (/stoptest — Admin-only,
 * Persian operational UI).
 *
 * Flow: /stoptest → status view (state + toggle button) → tap → CAS toggle +
 * settings_audit row → view re-rendered. The command itself NEVER mutates;
 * the toggle flips ONLY `enabled` in the versioned `free_test` document
 * (volume/duration/device policy byte-preserved), so existing test services,
 * claims, notifications and paid behavior are untouched by construction.
 *
 * Every entry point (command, callback) re-checks ctx.isAdmin server-side;
 * forged/misrouted/stale taps are inert and never write. A missing or
 * malformed document is reported and never seeded or repaired here (seeding
 * would invent policy — the loader stays fail-closed).
 */
import type { UpdateContext } from '../types.ts';
import { loadFreeTestConfig } from '../catalog/freeTest.ts';
import {
  applyFreeTestToggleCas,
  buildFreeTestDoc,
  getFreeTestSettingsRow,
  parseStoredFreeTestDoc,
} from '../db/freeTestSwitch.ts';
import { parseStoptestCallback } from '../lib/validate.ts';
import { stoptestKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';

const T = fa;

type StoptestView = 'active' | 'stopped' | 'broken';

/** Render the current switch state (admin-only surface — always `fa`). */
export async function showStoptestStatus(ctx: UpdateContext): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cmdAdminOnly);
    return;
  }
  await renderStoptestView(ctx);
}

async function currentView(db: D1Database): Promise<{ view: StoptestView }> {
  const loaded = await loadFreeTestConfig(db);
  if (!loaded.ok) return { view: 'broken' };
  return { view: loaded.config.enabled ? 'active' : 'stopped' };
}

async function renderStoptestView(ctx: UpdateContext): Promise<void> {
  const { view } = await currentView(ctx.db);
  const row = await getFreeTestSettingsRow(ctx.db);
  const lines: string[] = [];
  if (view === 'active') lines.push(T.adminStoptestStateActive);
  else if (view === 'stopped') lines.push(T.adminStoptestStateStopped);
  else lines.push(T.adminStoptestMalformed);
  if (row && row.updated_by) {
    lines.push(T.adminStoptestUpdated(`${row.updated_by} — ${row.updated_at.slice(0, 16)}`));
  }
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), stoptestKeyboard(view));
}

/**
 * Handles `stp:view` / `stp:stop` / `stp:start` (only ever data that already
 * passed isValidCallbackData + parseStoptestCallback + the isAdmin gate).
 */
export async function handleStoptestCallback(
  ctx: UpdateContext,
  data: string,
  callbackQueryId: string,
): Promise<void> {
  const action = parseStoptestCallback(data);
  if (action === null || !ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice, true);
    return;
  }
  if (action === 'view') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await renderStoptestView(ctx);
    return;
  }
  await toggleStoptest(ctx, action === 'stop', callbackQueryId);
}

async function toggleStoptest(
  ctx: UpdateContext,
  wantStopped: boolean,
  callbackQueryId: string,
): Promise<void> {
  const row = await getFreeTestSettingsRow(ctx.db);
  const base = row === null ? null : parseStoredFreeTestDoc(row.value);
  if (row === null || base === null) {
    // Missing/malformed document: nothing safe to flip — report, write nothing.
    await ctx.api.answerCallbackQuery(callbackQueryId, T.adminStoptestSaveFailed, true);
    await renderStoptestView(ctx);
    return;
  }
  if (base.enabled === !wantStopped) {
    // Idempotent tap (a replayed button on a superseded bubble): the state is
    // ALREADY what was asked — answer, re-render, and write NOTHING.
    await ctx.api.answerCallbackQuery(
      callbackQueryId,
      wantStopped ? T.adminStoptestAlreadyStopped : T.adminStoptestAlreadyStarted,
    );
  } else {
    // The raw stored string is the CAS token — concurrent admins converge on
    // one winner, the loser sees 'conflict' and the fresh state.
    const outcome = await applyFreeTestToggleCas(ctx.db, {
      oldJson: row.value,
      newJson: buildFreeTestDoc(base, !wantStopped),
      adminUserId: ctx.actor.id,
      action: wantStopped ? 'disable' : 'enable',
    });
    if (outcome === 'conflict') {
      await ctx.api.answerCallbackQuery(callbackQueryId, T.adminStoptestConflict, true);
    } else if (outcome === 'applied') {
      await ctx.api.answerCallbackQuery(
        callbackQueryId,
        wantStopped ? T.adminStoptestStoppedToast : T.adminStoptestStartedToast,
      );
    } else {
      // 'missing' (row vanished mid-flight): never claim success — the
      // re-render below shows the TRUE current state.
      await ctx.api.answerCallbackQuery(callbackQueryId, T.adminStoptestSaveFailed, true);
    }
  }
  await renderStoptestView(ctx);
}
