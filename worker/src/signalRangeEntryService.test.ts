import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWaitFromParsed,
  evaluatePreEntryStaleness,
  evaluateWakeEligibility,
} from './signalRangeEntryService'
import { virtualLegTriggerAllowed, virtualLegTriggerInZone } from './manualPlanning/signalEntryRange'
import { virtualPendingTriggerAllowed } from './tradeExecutor/helpers'

const zoneParsed = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: null,
  entry_zone_low: 4325,
  entry_zone_high: 4335,
  sl: 4320,
  tp: [4340, 4350],
  lot_size: null,
}

test('evaluatePreEntryStaleness: buy SL touched before entry', () => {
  const r = evaluatePreEntryStaleness({
    parsed: zoneParsed,
    bid: 4318,
    ask: 4319,
    isBuy: true,
  })
  assert.equal(r.stale, true)
  assert.equal(r.reason, 'sl_before_entry')
})

test('evaluatePreEntryStaleness: buy TP touched before entry', () => {
  const r = evaluatePreEntryStaleness({
    parsed: zoneParsed,
    bid: 4341,
    ask: 4342,
    isBuy: true,
  })
  assert.equal(r.stale, true)
  assert.equal(r.reason, 'tp_before_entry')
})

test('evaluatePreEntryStaleness: sell TP touched before entry', () => {
  const parsed = {
    ...zoneParsed,
    action: 'sell',
    tp: [4310],
    sl: 4345,
  }
  const r = evaluatePreEntryStaleness({
    parsed,
    bid: 4309,
    ask: 4310,
    isBuy: false,
  })
  assert.equal(r.stale, true)
  assert.equal(r.reason, 'tp_before_entry')
})

test('evaluatePreEntryStaleness: in-range not stale', () => {
  const r = evaluatePreEntryStaleness({
    parsed: zoneParsed,
    bid: 4328,
    ask: 4329,
    isBuy: true,
  })
  assert.equal(r.stale, false)
})

test('evaluateWakeEligibility: buy inside zone band', () => {
  const wait = buildWaitFromParsed({
    manual: { use_signal_entry_range: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: zoneParsed,
    isBuy: true,
  })!
  assert.equal(
    evaluateWakeEligibility({ wait, bid: 4328, ask: 4329, pipSize: 0.1 }),
    true,
  )
})

test('virtualLegTriggerInZone: rejects outside both edges', () => {
  assert.equal(virtualLegTriggerInZone({ trigger: 4324, zoneLo: 4325, zoneHi: 4335 }), false)
  assert.equal(virtualLegTriggerInZone({ trigger: 4336, zoneLo: 4325, zoneHi: 4335 }), false)
  assert.equal(virtualLegTriggerInZone({ trigger: 4330, zoneLo: 4325, zoneHi: 4335 }), true)
})

test('virtualLegTriggerAllowed: useFullZone clamps buy layers above zone high', () => {
  assert.equal(
    virtualLegTriggerAllowed({
      trigger: 4336,
      boundary: 4325,
      isBuy: true,
      zoneLo: 4325,
      zoneHi: 4335,
      useFullZone: true,
    }),
    false,
  )
  assert.equal(
    virtualLegTriggerAllowed({
      trigger: 4330,
      boundary: 4325,
      isBuy: true,
      zoneLo: 4325,
      zoneHi: 4335,
      useFullZone: true,
    }),
    true,
  )
})

test('virtualPendingTriggerAllowed: useSignalEntryRange enforces full zone', () => {
  assert.equal(
    virtualPendingTriggerAllowed({
      triggerPrice: 4336,
      signalRangeBoundary: 4325,
      isBuy: true,
      stopsZoneLo: null,
      stopsZoneHi: null,
      signalZoneLo: 4325,
      signalZoneHi: 4335,
      useSignalEntryRange: true,
    }),
    false,
  )
  assert.equal(
    virtualPendingTriggerAllowed({
      triggerPrice: 4330,
      signalRangeBoundary: 4325,
      isBuy: true,
      stopsZoneLo: null,
      stopsZoneHi: null,
      signalZoneLo: 4325,
      signalZoneHi: 4335,
      useSignalEntryRange: true,
    }),
    true,
  )
})
