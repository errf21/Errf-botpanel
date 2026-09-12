/**
 * Pure, dependency-free conversation state machine.
 *
 * Handlers map transport payloads (callback data / text) to semantic events,
 * then call `reduce`. Phase 3 adds real product steps by extending `FORWARD`
 * here and mapping `vol:`/`dur:`/`dev:` callbacks — the engine and the
 * persistence layer never change.
 */
import {
  CONVERSATION_STATES,
  type ConversationState,
} from '../types.ts';

export type ConversationEvent =
  | 'buy'
  | 'name_prompt_shown'
  | 'name_accepted'
  | 'volume_chosen'
  | 'duration_chosen'
  | 'devices_chosen'
  | 'order_confirmed'
  | 'receipt_received'
  | 'cancel'
  | 'back_to_menu'
  | 'none';

const FORWARD: Partial<
  Record<ConversationEvent, [ConversationState, ConversationState][]>
> = {
  buy: [['IDLE', 'BUYING']],
  name_prompt_shown: [['BUYING', 'WAITING_CONFIG_NAME']],
  name_accepted: [['WAITING_CONFIG_NAME', 'WAITING_VOLUME']],
  volume_chosen: [['WAITING_VOLUME', 'WAITING_DURATION']],
  duration_chosen: [['WAITING_DURATION', 'WAITING_DEVICE_LIMIT']],
  devices_chosen: [['WAITING_DEVICE_LIMIT', 'WAITING_ORDER_CONFIRMATION']],
  order_confirmed: [['WAITING_ORDER_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT']],
  receipt_received: [['WAITING_PAYMENT_RECEIPT', 'WAITING_PAYMENT_RECEIPT']],
};

export function isConversationState(value: string): value is ConversationState {
  return (CONVERSATION_STATES as readonly string[]).includes(value);
}

/**
 * Legal moves only. Invalid events leave the state untouched (fail-safe);
 * cancel/back are universally legal and always land on IDLE.
 */
export function reduce(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (event === 'cancel' || event === 'back_to_menu') return 'IDLE';
  const rules = FORWARD[event];
  if (!rules) return state;
  const match = rules.find(([from]) => from === state);
  return match ? match[1] : state;
}

/** True while the conversation flow is active (anything but IDLE). */
export function isBusy(state: ConversationState): boolean {
  return state !== 'IDLE';
}

/**
 * States accepted for customer text input. Phase 3 registers WAITING_VOLUME
 * prompts etc. by extending this (text is ignored elsewhere by design).
 */
export function acceptsTextInput(state: ConversationState): boolean {
  return state === 'WAITING_CONFIG_NAME';
}
