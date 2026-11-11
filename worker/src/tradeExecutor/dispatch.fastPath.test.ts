import assert from 'node:assert/strict'
import test from 'node:test'
import { isLiveMgmtFast, shouldUseMgmtFastPath } from './dispatch'
import type { SignalRow } from './types'

const baseParsed = {
  entry_price: null,
  entry_zone_low: null,
  entry_zone_high: null,
  sl: null as number | null,
  tp: [] as number[] | null,
  lot_size: null as number | null,
}

const mgmtSignal: SignalRow = {
  id: 'sig-1',
  user_id: 'user-1',
  channel_id: 'ch-1',
  parsed_data: { ...baseParsed, action: 'modify', symbol: 'XAUUSD', sl: 2650, tp: [2660] },
  status: 'parsed',
  parent_signal_id: null,
  is_modification: true,
}

test('shouldUseMgmtFastPath: close/modify actions qualify', () => {
  assert.equal(shouldUseMgmtFastPath({ ...mgmtSignal, parsed_data: { ...baseParsed, action: 'close', symbol: 'XAUUSD' } }), true)
  assert.equal(shouldUseMgmtFastPath(mgmtSignal), true)
  assert.equal(shouldUseMgmtFastPath({ ...mgmtSignal, parsed_data: { ...baseParsed, action: 'buy', symbol: 'XAUUSD' } }), false)
})

test('isLiveMgmtFast: requires liveDispatch and lightIdempotency (sweep/realtime fast path)', () => {
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: true, lightIdempotency: true, dispatchSource: 'sweep' },
      mgmtSignal.parsed_data,
      mgmtSignal,
    ),
    true,
  )
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: false, lightIdempotency: false, dispatchSource: 'sweep' },
      mgmtSignal.parsed_data,
      mgmtSignal,
    ),
    false,
  )
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: true, lightIdempotency: false, dispatchSource: 'realtime' },
      mgmtSignal.parsed_data,
      mgmtSignal,
    ),
    false,
  )
})

test('isLiveMgmtFast: listener_push mgmt uses fast path', () => {
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: true, lightIdempotency: true, dispatchSource: 'listener_push' },
      mgmtSignal.parsed_data,
      mgmtSignal,
    ),
    true,
  )
})

test('isLiveMgmtFast: listener_push teaser completion (param refresh) uses fast path', () => {
  // Zone + market-now + SL/TP completes a teaser basket → routes to merge-modify,
  // so leg modifies must run on the parallel fast path even from listener_push.
  const teaserCompletion: SignalRow = {
    ...mgmtSignal,
    id: 'sig-teaser',
    parsed_data: {
      ...baseParsed,
      action: 'sell',
      symbol: 'XAUUSD',
      entry_zone_low: 4033.6,
      entry_zone_high: 4037,
      sl: 4041,
      tp: [4031, 4029, 4027],
      raw_instruction: 'Gold sell now 4033.6 - 4037 SL: 4041 TP: 4031',
    },
  }
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: true, lightIdempotency: true, dispatchSource: 'listener_push' },
      teaserCompletion.parsed_data,
      teaserCompletion,
    ),
    true,
  )
})

test('shouldUseMgmtFastPath + isLiveMgmtFast: message_revision buy+SL/TP uses mgmt fast path', () => {
  // Edits keep action=buy and often say "buy now" — still must refresh legs fast.
  const edited: SignalRow = {
    ...mgmtSignal,
    id: 'sig-edit',
    parsed_data: {
      ...baseParsed,
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 4028,
      tp: [4042, 4045, 4049],
      raw_instruction: 'Gold buy now\nSL: 4028\nTP: 4042 4045 4049',
    },
    revision_prior_action: 'buy',
  }
  assert.equal(shouldUseMgmtFastPath(edited, 'message_revision'), true)
  assert.equal(
    isLiveMgmtFast(
      { liveDispatch: true, lightIdempotency: true, dispatchSource: 'message_revision' },
      edited.parsed_data,
      edited,
    ),
    true,
  )
})
