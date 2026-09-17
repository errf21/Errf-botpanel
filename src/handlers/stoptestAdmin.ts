/**
 * Phase 23: admin free-test stop/resume surface (/stoptest — Admin-only,
 * Persian operational UI). Phase 24 adds the volume control on the same
 * screen: the CURRENT configured volume/duration/devices render on every
 * status view, and `/stoptest vol <50MB|1GB|…>` rewrites ONLY `volume_mb`
 * (stateless command-args transport — no conversation state, no arming).
 *
 * Flow: /stoptest → status view (state + volume + buttons) → tap → CAS
 * toggle + settings_audit row → view re-rendered. The command itself NEVER
 * mutates (except `/stoptest vol …`, which is its own explicit write);
 * toggles flip ONLY `enabled`, volume writes change ONLY `volume_mb`, so
 * existing test services, claims, notifications and paid behavior are
 * untouched by construction.
 *
 * Every entry point (command, callback) re-checks ctx.isAdmin server-side;
 * forged/misrouted/stale taps are inert and never write. A missing or
 * malformed document is reported and never seeded or repaired here (seeding
 * would invent policy — the loader stays fail-closed).
 */
import type { UpdateContext } from '../types.ts';
import { loadFreeTestConfig, type FreeTestConfig } from '../catalog/freeTest.ts';
import {
  applyFreeTestToggleCas,
  buildFreeTestDoc,
  buildFreeTestVolumeDoc,
  getFreeTestSettingsRow,
  parseStoredFreeTestDoc,
  parseTestVolume,
} from '../db/freeTestSwitch.ts';
import { parseStoptestCallback } from '../lib/validate.ts';
import { stoptestKeyboard } from '../telegram/menu.ts';
import { FA_UI } from '../telegram/i18n.ts';
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

async function currentView(db: D1Database): Promise<{ view: StoptestView; config: FreeTestConfig | null }> {
  const loaded = await loadFreeTestConfig(db);
  if (!loaded.ok) return { view: 'broken', config: null };
  return { view: loaded.config.enabled ? 'active' : 'stopped', config: loaded.config };
}

/** Canonical admin volume display: ASCII digits + SI unit symbol. */
export function formatTestVolumeMb(volumeMb: number): string {
  return `${FA_UI.f.digits(volumeMb)} MB`;
}

async function renderStoptestView(ctx: UpdateContext): Promise<void> {
  const { view, config } = await currentView(ctx.db);
  const row = await getFreeTestSettingsRow(ctx.db);
  const lines: string[] = [];
  if (view === 'active') lines.push(T.adminStoptestStateActive);
  else if (view === 'stopped') lines.push(T.adminStoptestStateStopped);
  else lines.push(T.adminStoptestMalformed);
  if (config !== null) {
    lines.push(T.adminStoptestVolume(formatTestVolumeMb(config.volumeMb)));
    lines.push(T.adminStoptestDuration(FA_UI.f.dayCount(config.durationDays)));
    lines.push(T.adminStoptestDevices(FA_UI.f.deviceOption(config.deviceCount)));
  }
  if (row && row.updated_by) {
    lines.push(T.adminStoptestUpdated(`${row.updated_by} — ${row.updated_at.slice(0, 16)}`));
  }
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), stoptestKeyboard(T, view));
}

/**
 * Handles `stp:view` / `stp:stop` / `stp:start` / `stp:vol` (only ever data
 * that already passed isValidCallbackData + parseStoptestCallback + the
 * isAdmin gate). `stp:vol` only shows the input prompt — the value itself
 * arrives via `/stoptest vol …` (stateless).
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
  if (action === 'vol') {
    await ctx.api.answerCallbackQuery(callbackQueryId);
    await ctx.api.sendMessage(ctx.chatId, T.stoptestVolumePrompt);
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

/**
 * Phase 24: `/stoptest vol <50MB|500MB|1GB|…>` — stateless volume rewrite.
 * Admin-only; strict SI/integer/range validation; CAS-guarded write that
 * changes ONLY `volume_mb` (enabled/duration/devices preserved, so a volume
 * change can never accidentally enable the test); audit action 'volume'.
 * Any rejection leaves the configuration byte-untouched.
 */
export async function handleStoptestVolumeCommand(ctx: UpdateContext, rawValue: string): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.cmdAdminOnly);
    return;
  }
  const parsed = parseTestVolume(rawValue);
  if (!parsed.ok) {
    await ctx.api.sendMessage(ctx.chatId, T.stoptestVolumeInvalid);
    return;
  }
  const row = await getFreeTestSettingsRow(ctx.db);
  const base = row === null ? null : parseStoredFreeTestDoc(row.value);
  if (row === null || base === null) {
    await ctx.api.sendMessage(ctx.chatId, T.adminStoptestSaveFailed);
    await renderStoptestView(ctx);
    return;
  }
  if (base.volumeMb === parsed.volumeMb) {
    // Idempotent re-send of the current value: confirm, write NOTHING.
    await ctx.api.sendMessage(ctx.chatId, T.stoptestVolumeApplied(formatTestVolumeMb(parsed.volumeMb)));
    return;
  }
  const outcome = await applyFreeTestToggleCas(ctx.db, {
    oldJson: row.value,
    newJson: buildFreeTestVolumeDoc(base, parsed.volumeMb),
    adminUserId: ctx.actor.id,
    action: 'volume',
  });
  if (outcome === 'conflict') {
    await ctx.api.sendMessage(ctx.chatId, T.adminStoptestConflict);
  } else if (outcome === 'applied') {
    await ctx.api.sendMessage(ctx.chatId, T.stoptestVolumeApplied(formatTestVolumeMb(parsed.volumeMb)));
  } else {
    await ctx.api.sendMessage(ctx.chatId, T.adminStoptestSaveFailed);
  }
}
