/**
 * Phase 7 support tickets: the customer's one live ticket (open/answered)
 * with append-on-follow-up semantics, admin relay buttons and the /tickets
 * queue. Bodies are sanitized, never echoed back unfiltered; relays are
 * best-effort (delivered flag + /tickets re-push), and the DB is the truth —
 * a failed Telegram send never rolls the ticket back.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import { clearSession, setSession } from '../db/states.ts';
import {
  appendTicketMessage,
  createTicket,
  findLiveTicket,
  getTicketById,
  lastCustomerMessage,
  listLiveTickets,
  setTicketState,
  ticketSubject,
  SUPPORT_BODY_MAX,
  type TicketQueueRow,
} from '../db/support.ts';
import { getCustomerContact, resolveAdminChatIds } from '../db/customers.ts';
import { setPendingAdminTicketReply } from '../db/admin_actions.ts';
import {
  adminTicketKeyboard,
  adminTicketPushKeyboard,
  backToMenuKeyboard,
  composingKeyboard,
  mainMenuKeyboard,
  ticketAcknowledgedKeyboard,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { reduce } from '../state/machine.ts';

const TICKET_QUEUE_LIMIT = 10;
const TICKET_CODE_LEN = 8;

function ticketCode(ticketId: string): string {
  return ticketId.slice(0, TICKET_CODE_LEN);
}

async function notifyAdmins(
  ctx: UpdateContext,
  text: string,
  buttons?: Parameters<UpdateContext['api']['sendMessage']>[2],
): Promise<boolean> {
  const chatIds = await resolveAdminChatIds(ctx.env, ctx.db);
  let delivered = false;
  for (const chatId of chatIds) {
    if (await ctx.api.sendMessage(chatId, text, buttons)) delivered = true;
  }
  return delivered;
}

/** `menu:support` — intro (or reminder of the live ticket). */
export async function openSupportEntry(ctx: UpdateContext, session: Session): Promise<void> {
  if (session.state === 'WAITING_SUPPORT_MESSAGE') {
    // Still composing: keep the main keyboard hidden behind the back button.
    await ctx.api.sendMessage(ctx.chatId, fa.supportQueueChoice, composingKeyboard());
    return;
  }
  const live = await findLiveTicket(ctx.db, ctx.customerId);
  if (live) {
    // IDLE with a live ticket: follow-ups are ordinary text, menu stays up.
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.supportTicketExists(live.id)}\n\n${fa.supportQueueChoice}`,
      mainMenuKeyboard(),
    );
    return;
  }
  const next = reduce(session.state, 'support_start');
  if (next !== 'WAITING_SUPPORT_MESSAGE') {
    await ctx.api.sendMessage(ctx.chatId, fa.supportBusyFirst, backToMenuKeyboard());
    return;
  }
  await setSession(ctx.db, ctx.customerId, next, session.data);
  // Phase 8A: free-text composing — swap the bottom keyboard for [back].
  await ctx.api.sendMessage(ctx.chatId, fa.supportIntro, composingKeyboard());
}

/** First text of a new ticket (or plain follow-up when a ticket is open). */
export async function submitSupportText(
  ctx: UpdateContext,
  session: Session | null,
  body: string,
): Promise<void> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    if (session) await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.supportQueueChoice, mainMenuKeyboard());
    return;
  }
  const clipped = trimmed.slice(0, SUPPORT_BODY_MAX);
  const live = await findLiveTicket(ctx.db, ctx.customerId);
  if (live) {
    // Follow-up while open: append + re-notify, conversation returns to IDLE.
    await appendTicketMessage(ctx.db, { ticketId: live.id, sender: 'customer', body: clipped });
    await setTicketState(ctx.db, { ticketId: live.id, from: ['answered'], to: 'open' });
    await notifyAdmins(
      ctx,
      fa.adminTicketFollowup(
        ctx.actor.username ? `@${ctx.actor.username}` : String(ctx.actor.id),
        clipped.slice(0, 120),
      ),
      adminTicketPushKeyboard(live.id),
    );
    if (session) await clearSession(ctx.db, ctx.customerId);
    // Conversation is IDLE again: restore the main menu keyboard.
    await ctx.api.sendMessage(ctx.chatId, fa.supportTicketCreated(live.id), mainMenuKeyboard());
    return;
  }
  if (session && session.state !== 'WAITING_SUPPORT_MESSAGE') return; // never from elsewhere
  let outcome;
  try {
    outcome = await createTicket(ctx.db, { customerId: ctx.customerId, body: clipped });
  } catch {
    outcome = { ok: false as const, reason: 'already_open' as const };
  }
  if (!outcome.ok) {
    const existing = await findLiveTicket(ctx.db, ctx.customerId);
    if (existing) {
      await appendTicketMessage(ctx.db, { ticketId: existing.id, sender: 'customer', body: clipped });
      await notifyAdmins(
        ctx,
        fa.adminTicketFollowup(
          ctx.actor.username ? `@${ctx.actor.username}` : String(ctx.actor.id),
          clipped.slice(0, 120),
        ),
        adminTicketPushKeyboard(existing.id),
      );
      if (session) await clearSession(ctx.db, ctx.customerId);
      await ctx.api.sendMessage(
        ctx.chatId,
        fa.supportTicketCreated(existing.id),
        mainMenuKeyboard(),
      );
      return;
    }
    if (session) await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.supportQueueChoice, mainMenuKeyboard());
    return;
  }
  if (session) await clearSession(ctx.db, ctx.customerId);
  await notifyAdmins(
    ctx,
    `${fa.adminTicketNew(
      ctx.actor.username ? `@${ctx.actor.username}` : String(ctx.actor.id),
      ticketSubject(clipped),
    )}\n\n${clipped.slice(0, SUPPORT_BODY_MAX)}`,
    adminTicketPushKeyboard(outcome.ticket.id),
  );
  // Ticket created, conversation IDLE: restore the main menu keyboard.
  await ctx.api.sendMessage(
    ctx.chatId,
    fa.supportTicketCreated(outcome.ticket.id),
    mainMenuKeyboard(),
  );
}

/** /tickets — admin queue with per-ticket buttons. */
export async function showTicketQueue(ctx: UpdateContext): Promise<void> {
  const rows = await listLiveTickets(ctx.db, TICKET_QUEUE_LIMIT);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.adminTicketQueueEmpty);
    return;
  }
  const lines: string[] = [fa.adminTicketQueueHeader];
  const keyboard = {
    inline_keyboard: rows.map((row) => [
      { text: `🎫 ${ticketCode(row.id)} ${row.subject.slice(0, 24)}`.slice(0, 62), callback_data: `tsk:vw:${row.id}` },
      { text: '💬', callback_data: `tsk:rp:${row.id}` },
      { text: '✅', callback_data: `tsk:cl:${row.id}` },
    ]),
  };
  rows.forEach((row: TicketQueueRow, index) => {
    const who = row.telegram_username ? `@${row.telegram_username}` : row.telegram_user_id;
    lines.push(fa.adminTicketQueueEntry(index + 1, ticketCode(row.id), who, row.subject, row.messages));
  });
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), keyboard);
}

/** `tsk:vw` — render a ticket (admins only, from the queue/forward). */
export async function viewTicket(ctx: UpdateContext, ticketId: string, callbackQueryId: string): Promise<void> {
  const ticket = await getTicketById(ctx.db, ticketId);
  if (!ticket) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.ticketNotFound, true);
    return;
  }
  const last = await lastCustomerMessage(ctx.db, ticket.id);
  const customer = await getCustomerContact(ctx.db, ticket.customer_id);
  const who = customer?.telegram_user_id ?? fa.accountNone;
  const lines = [
    `🎫 ${ticketCode(ticket.id)} — ${ticket.state === 'open' ? '🔴' : '🟢'}`,
    `👤 ${fa.accountNone === who ? who : who}${customer?.first_name ? ` (${customer.first_name})` : ''}`,
    `📝 ${ticket.subject}`,
    last ? `💬 ${last.body.slice(0, 400)}` : '',
  ].filter(Boolean);
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n'), adminTicketKeyboard(ticket.id));
}

/** `tsk:cl` — close (guarded state flip). */
export async function closeTicket(
  ctx: UpdateContext,
  ticketId: string,
  callbackQueryId: string,
): Promise<void> {
  const flipped = await setTicketState(ctx.db, { ticketId, from: ['open', 'answered'], to: 'closed' });
  await ctx.api.answerCallbackQuery(callbackQueryId, flipped ? fa.adminTicketSent : fa.adminTicketStale);
  if (flipped) {
    const contact = await notifyCustomerTicketClosed(ctx, ticketId);
    void contact;
  }
}

async function notifyCustomerTicketClosed(ctx: UpdateContext, ticketId: string): Promise<boolean> {
  const ticket = await getTicketById(ctx.db, ticketId);
  if (!ticket) return false;
  const contact = await getCustomerContact(ctx.db, ticket.customer_id);
  const chatId = Number(contact?.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  return Boolean(await ctx.api.sendMessage(chatId, fa.supportClosedNotice));
}

/**
 * Admin reply armed via `tsk:rp` or the push keyboard: stores the answer,
 * flips the ticket to 'answered' and pushes it to the customer. Called from
 * the admin pending-action intercept in messages.ts.
 */
export async function deliverTicketReply(
  ctx: UpdateContext,
  ticketId: string,
  body: string,
): Promise<'sent' | 'stale' | 'undelivered'> {
  const ticket = await getTicketById(ctx.db, ticketId);
  if (!ticket || ticket.state === 'closed') return 'stale';
  const sender = `admin:${String(ctx.actor.id)}`;
  const message = await appendTicketMessage(ctx.db, { ticketId, sender, body });
  if (!message) return 'stale';
  await setTicketState(ctx.db, { ticketId, from: ['open', 'answered'], to: 'answered' });
  const contact = await getCustomerContact(ctx.db, ticket.customer_id);
  const chatId = Number(contact?.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return 'undelivered';
  const delivered = await ctx.api.sendMessage(
    chatId,
    `${fa.supportAnswered}${body}`,
    ticketAcknowledgedKeyboard(),
  );
  if (!delivered) {
    await appendTicketMessage(ctx.db, { ticketId, sender, body, delivered: false });
    return 'undelivered';
  }
  return 'sent';
}

/** `tsk:rp` tap: arm the admin's next message as the reply. */
export async function armTicketReply(
  ctx: UpdateContext,
  ticketId: string,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  const ticket = await getTicketById(ctx.db, ticketId);
  if (!ticket || ticket.state === 'closed') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.adminTicketStale, true);
    return;
  }
  await setPendingAdminTicketReply(ctx.db, ctx.actor.id, ticketId);
  await ctx.api.answerCallbackQuery(callbackQueryId);
  // Phase 8A: admin now composes free text — hide the main keyboard.
  await ctx.api.sendMessage(ctx.chatId, fa.adminTicketPrompt, composingKeyboard());
  void messageChatId;
  void messageId;
}
