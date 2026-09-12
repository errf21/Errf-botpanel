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
