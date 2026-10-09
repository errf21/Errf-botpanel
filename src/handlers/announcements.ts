/**
 * Phase 7 announcements: draft → confirm → durable job → chunked waitUntil
 * sends with automatic scheduled continuation (button is optional progress/retry). Each pass claims and books at
 * most ANNOUNCE_CHUNK recipients, so a webhook response always stays fast;
 * the per-recipient UNIQUE row makes every resume/replay converge.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import {resolveAdminChatIds} from '../db/customers.ts';
import { clearSession, getSession, setSession } from '../db/states.ts';
import {
  ANNOUNCE_CHUNK,
  announcementAggregate,
  countPotentialRecipients,
  createAnnouncement,
  getAnnouncement,
  listRecentAnnouncementProgress,
  runAnnouncementChunk,
  startAnnouncement,
} from '../db/announcements.ts';
import {
  announceConfirmKeyboard,
  announceProgressKeyboard,
  backToMenuKeyboard,
  composingKeyboard,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { FA_UI } from '../telegram/i18n.ts';
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
    await ctx.api.sendMessage(ctx.chatId, fa.supportBusyFirst, backToMenuKeyboard(FA_UI));
    return;
  }
  await setSession(ctx.db, ctx.customerId, next, session.data);
  // Phase 8A: admin composes the draft as free text — hide the main keyboard.
  await ctx.api.sendMessage(ctx.chatId, fa.announceIntro, composingKeyboard(FA_UI));
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
    await ctx.api.sendMessage(ctx.chatId, fa.announceTooLong, composingKeyboard(FA_UI));
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
    await ctx.api.sendMessage(ctx.chatId, fa.announceTooLong, composingKeyboard(FA_UI));
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
 * production — the admin sees progress; scheduled continuation needs no button.
 */
async function runPass(
  ctx: UpdateContext,
  announcementId: string,
  body: string,
): Promise<{ sent: number; failed: number; total: number; done: boolean; code: string }> {

  await runAnnouncementChunk(ctx.db, ctx.api, body, announcementId, ANNOUNCE_CHUNK);
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

/** Admin confirmation/manual status pass; cron also continues confirmed jobs. */
export async function runAnnouncementPass(
  ctx: UpdateContext,
  announcementId: string,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  if(!ctx.isAdmin){await ctx.api.answerCallbackQuery(callbackQueryId,fa.invalidChoice,true);return;}
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
  if(!record.started_at && (session?.state!=='WAITING_ANNOUNCE_CONFIRM'||session.data.announcement_id!==record.id||record.created_by!==`admin:${ctx.actor.id}`)){
    await ctx.api.answerCallbackQuery(callbackQueryId,fa.announceStale,true);return;
  }
  await startAnnouncement(ctx.db,announcementId);
  if (session?.state === 'WAITING_ANNOUNCE_CONFIRM') {
    await clearSession(ctx.db, ctx.customerId);
  }
  const pass = (async () => {
    const result = await runPass(ctx, announcementId, record.body);
    const text = result.done
      ? fa.announceDone(result.code, result.sent, result.failed)
      : fa.announceProgress(result.code, result.sent, result.total)+'\nAutomatic background delivery continues; no repeated Continue taps required.';
    const keyboard = result.done ? backToMenuKeyboard(FA_UI) : announceProgressKeyboard(announcementId);
    if (messageChatId !== null && messageId !== null && messageChatId === ctx.chatId) {
      await ctx.api.editMessageText(messageChatId, messageId, text, keyboard);
    } else {
      await ctx.api.sendMessage(ctx.chatId, text, keyboard);
    }
    if(result.done){for(const chatId of await resolveAdminChatIds(ctx.env,ctx.db)){
      await ctx.api.sendMessage(chatId,fa.announceDone(result.code,result.sent,result.failed));
    }}
    return result;
  })();
  if (ctx.waitUntil) ctx.waitUntil(pass);
  else await pass;
  await ctx.api.answerCallbackQuery(callbackQueryId);
}

/** `/announcements` — status list + continue button (admins only). */
export async function showAnnouncements(ctx: UpdateContext): Promise<void> {
  const rows = await listRecentAnnouncementProgress(ctx.db, 5);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.announceQueueEmpty);
    return;
  }
  const lines: string[] = [fa.announceQueueHeader];
  for (const row of rows) {
    const agg = row.progress;
    lines.push(
      fa.announceQueueEntry(
        row.id,
        row.state === 'done' ? fa.announceStateDone : fa.announceStateSending,
        agg.sent,
        agg.total,
      )+`\nFailed: ${agg.failed}; pending: ${agg.pending}; active: ${agg.stuck}; retryable: ${agg.retryable}; delayed: ${agg.delayed}${agg.seeding?'; audience seeding':''}`,
    );
  }
  const unfinished = rows.find((row) => row.state === 'sending');
  const keyboard = unfinished ? announceProgressKeyboard(unfinished.id) : backToMenuKeyboard(FA_UI);
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), keyboard);
}

/** /cancel / back: drop an unconfirmed draft conversation. */
export async function abandonAnnounceDraft(ctx: UpdateContext): Promise<void> {
  await clearSession(ctx.db, ctx.customerId);
}

/** Existing five-minute cron automatically continues every confirmed job.
 * Two chunks per sweep, fair oldest-job rotation, no new Cloudflare product. */
export async function runAnnouncementSweep(env:import('../types.ts').Env,apiOverride?:import('../types.ts').TelegramApiLike,runtime:import('../db/announcements.ts').AnnouncementRuntime={}):Promise<number>{
 const {TelegramApi}=await import('../telegram/api.ts');const api=apiOverride??new TelegramApi(env.TELEGRAM_BOT_TOKEN);
 const now=runtime.now??Date.now,deadline=runtime.deadline??now()+22000;let sent=0;
 for(let pass=0;pass<2&&now()+8000<deadline;pass++){
  const job=await env.DB.prepare("SELECT * FROM announcements WHERE state='sending' AND started_at IS NOT NULL AND EXISTS(SELECT 1 FROM announcement_dispatch WHERE singleton=1 AND pause_until<=?1 AND lease_until<=?1) AND (audience_seeded=0 OR recipient_count=sent_count+failed_count OR EXISTS(SELECT 1 FROM announcement_deliveries d WHERE d.announcement_id=announcements.id AND ((d.status='pending' AND d.next_attempt_at<=?1) OR (d.status='sending' AND COALESCE(d.lease_until,0)<=?1)))) ORDER BY updated_at,id LIMIT 1").bind(now()).first<import('../db/announcements.ts').AnnouncementRow>();
  if(!job)break;
  const processed=await runAnnouncementChunk(env.DB,api,job.body,job.id,ANNOUNCE_CHUNK,{...runtime,deadline});sent+=processed;
  await env.DB.prepare("UPDATE announcements SET updated_at=?2 WHERE id=?1 AND state='sending'").bind(job.id,new Date(now()).toISOString()).run();
  if(!processed)break;
 }
 return sent;
}
