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
  | 'renew_start'
  | 'renew_duration_chosen'
  | 'renew_confirmed'
  | 'step_back'
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
  // Phase 6 renewals: a compact two-step ladder that hands over to the SAME
  // WAITING_PAYMENT_RECEIPT state, so receipt/admin/provisioning reuse it all.
  renew_start: [['IDLE', 'WAITING_RENEWAL_DURATION']],
  renew_duration_chosen: [['WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_CONFIRMATION']],
  renew_confirmed: [['WAITING_RENEWAL_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT']],
};

export function isConversationState(value: string): value is ConversationState {
  return (CONVERSATION_STATES as readonly string[]).includes(value);
}

/**
 * Edit ladder: back returns to the previous purchase step. Once the order is
 * durable (WAITING_PAYMENT_RECEIPT) drafts are frozen — going back there
 * would desync the committed order from the conversation.
 */
const BACK_MAP: Partial<Record<ConversationState, ConversationState>> = {
  WAITING_VOLUME: 'WAITING_CONFIG_NAME',
  WAITING_DURATION: 'WAITING_VOLUME',
  WAITING_DEVICE_LIMIT: 'WAITING_DURATION',
  WAITING_ORDER_CONFIRMATION: 'WAITING_DEVICE_LIMIT',
  WAITING_PAYMENT_RECEIPT: 'WAITING_PAYMENT_RECEIPT',
  // Renewal ladder back (its duration step backs out to IDLE via the map miss).
  WAITING_RENEWAL_CONFIRMATION: 'WAITING_RENEWAL_DURATION',
};

/**
 * Legal moves only. Invalid events leave the state untouched (fail-safe);
 * cancel/back are universally legal and always land on IDLE.
 */
export function reduce(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (event === 'cancel' || event === 'back_to_menu') return 'IDLE';
  if (event === 'step_back') return BACK_MAP[state] ?? 'IDLE';
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
 * States that consume free-text input. Text is parsed as a name in
 * WAITING_CONFIG_NAME and as a custom numeric value in each option step.
 */
const TEXT_ACCEPTING_STATES: readonly ConversationState[] = [
  'WAITING_CONFIG_NAME',
  'WAITING_VOLUME',
  'WAITING_DURATION',
  'WAITING_DEVICE_LIMIT',
];

export function acceptsTextInput(state: ConversationState): boolean {
  return TEXT_ACCEPTING_STATES.includes(state);
}
