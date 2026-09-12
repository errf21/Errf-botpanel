import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduce,
  isConversationState,
  isBusy,
  acceptsTextInput,
  type ConversationEvent,
} from '../src/state/machine.ts';

const ALL_STATES = [
  'IDLE', 'BUYING', 'WAITING_CONFIG_NAME', 'WAITING_VOLUME',
  'WAITING_DURATION', 'WAITING_DEVICE_LIMIT', 'WAITING_ORDER_CONFIRMATION',
  'WAITING_PAYMENT_RECEIPT',
] as const;

test('recognizes every valid conversation state and rejects others', () => {
  for (const state of ALL_STATES) {
    assert.equal(isConversationState(state), true);
  }
  assert.equal(isConversationState('HACK_ME'), false);
  assert.equal(isConversationState(''), false);
});

test('buy only starts from IDLE', () => {
  assert.equal(reduce('IDLE', 'buy'), 'BUYING');
  assert.equal(reduce('BUYING', 'buy'), 'BUYING');
  assert.equal(reduce('WAITING_VOLUME', 'buy'), 'WAITING_VOLUME');
});

test('full legal purchase ladder', () => {
  let state = reduce('IDLE', 'buy');
  state = reduce(state, 'name_prompt_shown');
  assert.equal(state, 'WAITING_CONFIG_NAME');
  state = reduce(state, 'name_accepted');
  assert.equal(state, 'WAITING_VOLUME');
  state = reduce(state, 'volume_chosen');
  assert.equal(state, 'WAITING_DURATION');
  state = reduce(state, 'duration_chosen');
  assert.equal(state, 'WAITING_DEVICE_LIMIT');
  state = reduce(state, 'devices_chosen');
  assert.equal(state, 'WAITING_ORDER_CONFIRMATION');
  state = reduce(state, 'order_confirmed');
  assert.equal(state, 'WAITING_PAYMENT_RECEIPT');
});

test('out-of-order events never advance the flow', () => {
  const bad: [typeof ALL_STATES[number], ConversationEvent][] = [
    ['IDLE', 'name_accepted'],
    ['WAITING_CONFIG_NAME', 'volume_chosen'],
    ['WAITING_DURATION', 'devices_chosen'],
    ['WAITING_VOLUME', 'order_confirmed'],
  ];
  for (const [state, event] of bad) {
    assert.equal(reduce(state, event), state);
  }
});

test('cancel/back are legal from every state and always land on IDLE', () => {
  for (const state of ALL_STATES) {
    if (state === 'IDLE') continue;
    assert.equal(reduce(state, 'cancel'), 'IDLE');
    assert.equal(reduce(state, 'back_to_menu'), 'IDLE');
  }
  assert.equal(reduce('IDLE' as (typeof ALL_STATES)[number], 'cancel'), 'IDLE');
});

test('unknown events are no-ops (fail-safe)', () => {
  for (const state of ALL_STATES) {
    assert.equal(reduce(state, 'none'), state);
    assert.equal(reduce(state, 'not_an_event' as ConversationEvent), state);
  }
});

test('busy flag and text-input gating', () => {
  assert.equal(isBusy('IDLE'), false);
  assert.equal(isBusy('WAITING_VOLUME'), true);
  assert.equal(acceptsTextInput('WAITING_CONFIG_NAME'), true);
  assert.equal(acceptsTextInput('IDLE'), false);
});
