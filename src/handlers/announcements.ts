/**
 * Phase 7 announcements: draft → confirm → durable job → chunked waitUntil
 * sends with an admin continuation button. Each pass claims and books at
 * most ANNOUNCE_CHUNK recipients, so a webhook response always stays fast;
 * the per-recipient UNIQUE row makes every resume/replay converge.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import { clearSession, getSession, setSession } from '../db/states.ts';
import {
  ANNOUNCE_CHUNK,
  announcementAggregate,
  countPotentialRecipients,
  createAnnouncement,
  getAnnouncement,
  listRecentAnnouncements,
  runAnnouncementChunk,
  seedAnnouncementDeliveries,
  settleAnnouncement,
  sweepStuckDeliveries,
} from '../db/announcements.ts';
import { resolveAdminChatIds } from '../db/customers.ts';
import {
  announceConfirmKeyboard,
  announceProgressKeyboard,
  backToMenuKeyboard,
  composingKeyboard,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { sanitizeSupportBody } from '../lib/validate.ts';
import { reduce } from '../state/machine.ts';

export const ANNOUNCE_TEXT_MAX = 2000;
const STATUS_CODE_LEN = 8;

function statusCode(id: string): string {
  return id.slice(0, STATUS_CODE_LEN);
}

/** `/announce`: enter the draft state (admins only — checked by caller). */
export async function startAnnounceDraft(ctx: UpdateContext, session: Session): Promise<void> {
  const next = reduce(session.state, 'announce_start');
  if (next !== 'WAITING_ANNOUNCE_TEXT') {
    await ctx.api.sendMessage(ctx.chatId, fa.supportBusyFirst, backToMenuKeyboard());
    return;
  }
  await setSession(ctx.db, ctx.customerId, next, session.data);
  // Phase 8A: admin composes the draft as free text — hide the main keyboard.
  await ctx.api.sendMessage(ctx.chatId, fa.announceIntro, composingKeyboard());
}

/** The draft text lands here (text router while WAITING_ANNOUNCE_TEXT). */
export async function saveAnnounceDraft(
  ctx: UpdateContext,
  session: Session,
  text: string,
): Promise<void> {
  if (session.state !== 'WAITING_ANNOUNCE_TEXT') return;
  const body = sanitizeSupportBody(text, ANNOUNCE_TEXT_MAX);
  if (!body) {
    await ctx.api.sendMessage(ctx.chatId, fa.announceTooLong, composingKeyboard());
    return;
  }
  const total = await countPotentialRecipients(ctx.db);
  let record: Awaited<ReturnType<typeof createAnnouncement>> = null;
  try {
    record = await createAnnouncement(ctx.db, {
      body,
      createdBy: `admin:${String(ctx.actor.id)}`,
      totalEstimate: total,
    });
  } catch {
    record = null;
  }
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.announceTooLong, composingKeyboard());
    return;
  }
  const next = reduce(session.state, 'announce_draft_saved');
  await setSession(ctx.db, ctx.customerId, next, {
    ...session.data,
    announcement_id: record.id,
  });
  const preview = record.body.slice(0, 600) + (record.body.length > 600 ? '…' : '');
  await ctx.api.sendMessage(
    ctx.chatId,
    `${fa.announceReceived}\n\n${preview}\n\n${fa.announceConfirmPrompt(total)}`,
    announceConfirmKeyboard(record.id),
  );
}

/**
 * One fan-out pass: seed (first tap), sweep abandoned claims, run a chunk,
 * settle. Inline when the harness has no waitUntil; deferred past the ACK in
 * production — either way the admin sees progress and the button continues.
 */
async function runPass(
  ctx: UpdateContext,
  announcementId: string,
  body: string,
): Promise<{ sent: number; failed: number; total: number; done: boolean; code: string }> {
  await seedAnnouncementDeliveries(ctx.db, announcementId);
  await sweepStuckDeliveries(ctx.db, announcementId);
  await runAnnouncementChunk(ctx.db, ctx.api, body, announcementId, ANNOUNCE_CHUNK);
  await settleAnnouncement(ctx.db, announcementId);
  const agg = await announcementAggregate(ctx.db, announcementId);
  const fresh = await getAnnouncement(ctx.db, announcementId);
  return {
    sent: agg.sent,
    failed: agg.failed,
    total: agg.total,
    done: fresh?.state === 'done',
    code: statusCode(announcementId),
  };
}

/** `ann:go` (confirm) / `ann:ct` (continue): the ONLY fan-out entry point. */
export async function runAnnouncementPass(
  ctx: UpdateContext,
  announcementId: string,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  const record = await getAnnouncement(ctx.db, announcementId);
  if (!record || record.state !== 'sending') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.announceStale, true);
    return;
  }
  if (!ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.invalidChoice, true);
    return;
  }
  // The confirming admin conversation ends at the first tap either way.
  const session = await getSession(ctx.db, ctx.customerId).catch(() => null);
  if (session?.state === 'WAITING_ANNOUNCE_CONFIRM') {
    await clearSession(ctx.db, ctx.customerId);
  }
  const pass = (async () => {
    const result = await runPass(ctx, announcementId, record.body);
    const text = result.done
      ? fa.announceDone(result.code, result.sent, result.failed)
      : fa.announceProgress(result.code, result.sent, result.total);
    const keyboard = result.done ? backToMenuKeyboard() : announceProgressKeyboard(announcementId);
    if (messageChatId !== null && messageId !== null && messageChatId === ctx.chatId) {
      await ctx.api.editMessageText(messageChatId, messageId, text, keyboard);
    } else {
      await ctx.api.sendMessage(ctx.chatId, text, keyboard);
    }
    if (result.done) {
      const chatIds = await resolveAdminChatIds(ctx.env, ctx.db);
      for (const chatId of chatIds) {
        try {
          await ctx.api.sendMessage(chatId, fa.announceDone(result.code, result.sent, result.failed));
        } catch {
          /* fire and forget — the queue command is the recovery path */
        }
      }
    }
    return result;
  })();
  if (ctx.waitUntil) ctx.waitUntil(pass);
  else await pass;
  await ctx.api.answerCallbackQuery(callbackQueryId);
}

/** `/announcements` — status list + continue button (admins only). */
export async function showAnnouncements(ctx: UpdateContext): Promise<void> {
  const rows = await listRecentAnnouncements(ctx.db, 5);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.announceQueueEmpty);
    return;
  }
  const lines: string[] = [fa.announceQueueHeader];
  for (const row of rows) {
    const agg = await announcementAggregate(ctx.db, row.id);
    lines.push(
      fa.announceQueueEntry(
        row.id,
        row.state === 'done' ? fa.announceStateDone : fa.announceStateSending,
        agg.sent,
        agg.total,
      ),
    );
  }
  const unfinished = rows.find((row) => row.state === 'sending');
  const keyboard = unfinished ? announceProgressKeyboard(unfinished.id) : backToMenuKeyboard();
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), keyboard);
}

/** /cancel / back: drop an unconfirmed draft conversation. */
export async function abandonAnnounceDraft(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
}
