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
  | 'renew_volume_chosen'
  | 'renew_confirmed'
  // Phase 18 repurchase: mode pick, then same-spec confirm OR the
  // volume → duration → device customize ladder, handing over to the SAME
  // WAITING_PAYMENT_RECEIPT state so receipt/admin/provisioning reuse it all.
  | 'repurchase_start'
  | 'repurchase_same'
  | 'repurchase_custom'
  | 'repurchase_volume_chosen'
  | 'repurchase_duration_chosen'
  | 'repurchase_device_chosen'
  | 'repurchase_confirmed'
  | 'support_start'
  | 'support_message_sent'
  | 'announce_start'
  | 'announce_draft_saved'
  | 'announce_confirmed'
  | 'topup_start'
  | 'topup_amount_accepted'
  | 'topup_receipt_received'
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
  // Phase 6 renewals + volume add-on: duration → volume → confirmation,
  // handing over to the SAME WAITING_PAYMENT_RECEIPT state, so
  // receipt/admin/provisioning reuse it all.
  renew_start: [['IDLE', 'WAITING_RENEWAL_DURATION']],
  renew_duration_chosen: [['WAITING_RENEWAL_DURATION', 'WAITING_RENEWAL_VOLUME']],
  renew_volume_chosen: [['WAITING_RENEWAL_VOLUME', 'WAITING_RENEWAL_CONFIRMATION']],
  renew_confirmed: [['WAITING_RENEWAL_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT']],
  // Phase 18 repurchase (renewal ladder above stays for in-flight drains).
  repurchase_start: [['IDLE', 'WAITING_REPURCHASE_MODE']],
  repurchase_same: [['WAITING_REPURCHASE_MODE', 'WAITING_REPURCHASE_CONFIRMATION']],
  repurchase_custom: [['WAITING_REPURCHASE_MODE', 'WAITING_REPURCHASE_VOLUME']],
  repurchase_volume_chosen: [['WAITING_REPURCHASE_VOLUME', 'WAITING_REPURCHASE_DURATION']],
  repurchase_duration_chosen: [['WAITING_REPURCHASE_DURATION', 'WAITING_REPURCHASE_DEVICE']],
  repurchase_device_chosen: [['WAITING_REPURCHASE_DEVICE', 'WAITING_REPURCHASE_CONFIRMATION']],
  repurchase_confirmed: [['WAITING_REPURCHASE_CONFIRMATION', 'WAITING_PAYMENT_RECEIPT']],
  // Phase 7 support: a one-message ladder. The ticket itself lives in D1
  // (open until closed), so after the message is sent the conversation is
  // IDLE again — follow-up routing keys off the open-ticket lookup, not state.
  support_start: [['IDLE', 'WAITING_SUPPORT_MESSAGE']],
  support_message_sent: [['WAITING_SUPPORT_MESSAGE', 'IDLE']],
  // Phase 7 announcements: admin drafts text, confirms, and a waitUntil job
  // fans it out. Confirmation exits to IDLE (sending continues in background).
  announce_start: [['IDLE', 'WAITING_ANNOUNCE_TEXT']],
  announce_draft_saved: [['WAITING_ANNOUNCE_TEXT', 'WAITING_ANNOUNCE_CONFIRM']],
  announce_confirmed: [['WAITING_ANNOUNCE_CONFIRM', 'IDLE']],
  // Phase 17 top-up: isolated from orders — amount text, then receipt media.
  // The receipt state self-loops so a replacement receipt stays in place.
  topup_start: [['IDLE', 'WAITING_TOPUP_AMOUNT']],
  topup_amount_accepted: [['WAITING_TOPUP_AMOUNT', 'WAITING_TOPUP_RECEIPT']],
  topup_receipt_received: [['WAITING_TOPUP_RECEIPT', 'WAITING_TOPUP_RECEIPT']],
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
  // Renewal ladder back: confirmation → volume → duration → IDLE (map miss).
  WAITING_RENEWAL_VOLUME: 'WAITING_RENEWAL_DURATION',
  WAITING_RENEWAL_CONFIRMATION: 'WAITING_RENEWAL_VOLUME',
  // Repurchase ladder back: confirmation → device → duration → volume →
  // mode → IDLE (map miss on the mode state).
  WAITING_REPURCHASE_VOLUME: 'WAITING_REPURCHASE_MODE',
  WAITING_REPURCHASE_DURATION: 'WAITING_REPURCHASE_VOLUME',
  WAITING_REPURCHASE_DEVICE: 'WAITING_REPURCHASE_DURATION',
  WAITING_REPURCHASE_CONFIRMATION: 'WAITING_REPURCHASE_DEVICE',
  // Top-up receipt is durable-adjacent (request row exists): frozen like payment.
  WAITING_TOPUP_RECEIPT: 'WAITING_TOPUP_RECEIPT',
  WAITING_TOPUP_AMOUNT: 'IDLE',
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
  // Renewal custom add-on volume is typed free-text in its own step (purchase
  // WAITING_VOLUME precedent); duration/confirmation steps stay button-only.
  'WAITING_RENEWAL_VOLUME',
  // Repurchase customize steps accept typed custom numbers exactly like the
  // purchase ladder; mode/confirmation steps stay button-only.
  'WAITING_REPURCHASE_VOLUME',
  'WAITING_REPURCHASE_DURATION',
  'WAITING_REPURCHASE_DEVICE',
  // Phase 7: support body and announcement text are free-text by design.
  'WAITING_SUPPORT_MESSAGE',
  'WAITING_ANNOUNCE_TEXT',
  // Phase 17: top-up amount is free-text by design.
  'WAITING_TOPUP_AMOUNT',
];

export function acceptsTextInput(state: ConversationState): boolean {
  return TEXT_ACCEPTING_STATES.includes(state);
}
