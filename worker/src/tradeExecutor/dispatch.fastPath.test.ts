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
