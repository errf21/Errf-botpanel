import type { ConversationState, StateData } from '../types.ts';
import { isConversationState } from '../state/machine.ts';

/** Conversation-state repository: one row per customer, 24h idle expiry. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface Session {
  state: ConversationState;
  data: StateData;
}

const IDLE: Session = { state: 'IDLE', data: {} };

/** Expired/missing/invalid rows degrade to IDLE (never trap a user). */
export async function getSession(
  db: D1Database,
  customerId: number,
): Promise<Session> {
  const row = await db
    .prepare(
      `SELECT state, data FROM conversation_states
        WHERE customer_id = ?1
          AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .bind(customerId, new Date().toISOString())
    .first<{ state: string; data: string }>();
  if (!row || !isConversationState(row.state)) return IDLE;
  let data: StateData = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed && typeof parsed === 'object') data = parsed as StateData;
  } catch {
    data = {};
  }
  return { state: row.state, data };
}

/** Insert-or-replace keeps writes replay-safe (idempotent on webhook retries). */
export async function setSession(
  db: D1Database,
  customerId: number,
  state: ConversationState,
  data: StateData = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO conversation_states
         (customer_id, state, data, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(
      customerId,
      state,
      JSON.stringify(data),
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    )
    .run();
}

export async function clearSession(
  db: D1Database,
  customerId: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM conversation_states WHERE customer_id = ?1')
    .bind(customerId)
    .run();
}

/**
 * Restore IDLE after a repurchase cancellation WITHOUT clobbering unrelated
 * or newer work: deletes the session only when it is a repurchase-specific
 * state, or WAITING_PAYMENT_RECEIPT bound to THIS order id. Returns true when
 * the session was cleared.
 */
export async function clearRepurchaseSessionIfMatches(
  db: D1Database,
  customerId: number,
  orderId: string,
): Promise<boolean> {
  const session = await getSession(db, customerId);
  if (session.state === 'IDLE') return false;
  const repurchaseStates = new Set([
    'WAITING_REPURCHASE_MODE',
    'WAITING_REPURCHASE_VOLUME',
    'WAITING_REPURCHASE_DURATION',
    'WAITING_REPURCHASE_DEVICE',
    'WAITING_REPURCHASE_CONFIRMATION',
  ]);
  if (repurchaseStates.has(session.state)) {
    await clearSession(db, customerId);
    return true;
  }
  if (session.state === 'WAITING_PAYMENT_RECEIPT') {
    const bound = (session.data as Record<string, unknown>)['order_id'];
    if (bound === orderId) {
      await clearSession(db, customerId);
      return true;
    }
  }
  return false;
}
