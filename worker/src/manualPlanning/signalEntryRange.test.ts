import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ManualSettings, ParsedSignal } from './types'
import {
  resolveRangeDistancePips,
  signalRangeBoundary,
  signalRangeEntryQuoteAllowsImmediate,
  signalZoneWidthPips,
  virtualLegTriggerAllowed,
  buildRangeEntryWait,
} from './signalEntryRange'
import { triggerPriceFor, virtualPendingTriggerAllowed } from '../tradeExecutor/helpers'

const zoneParsed: ParsedSignal = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: null,
  entry_zone_low: 4325,
  entry_zone_high: 4335,
  sl: 4320,
  tp: [4340],
  lot_size: null,
}

test('signalZoneWidthPips: XAUUSD zone 4335/4325 → 100 pips at pip 0.1', () => {
  assert.equal(signalZoneWidthPips(zoneParsed, 0.1), 100)
})

test('signalRangeBoundary: buy → low, sell → high', () => {
  assert.equal(signalRangeBoundary(zoneParsed, true), 4325)
  assert.equal(signalRangeBoundary(zoneParsed, false), 4335)
})

test('resolveRangeDistancePips: toggle on + zone uses signal width and boundary', () => {
  const manual: ManualSettings = {
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const r = resolveRangeDistancePips({ manual, parsed: zoneParsed, pip: 0.1, isBuy: true })
  assert.equal(r.source, 'signal_zone')
  assert.equal(r.distPips, 100)
  assert.equal(r.boundary, 4325)
})

test('resolveRangeDistancePips: toggle on + no zone falls back to manual distance', () => {
  const manual: ManualSettings = {
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const parsed: ParsedSignal = { ...zoneParsed, entry_zone_low: null, entry_zone_high: null, entry_price: 4330 }
  const r = resolveRangeDistancePips({ manual, parsed, pip: 0.1, isBuy: true })
  assert.equal(r.source, 'manual')
  assert.equal(r.distPips, 30)
  assert.equal(r.boundary, null)
})

test('resolveRangeDistancePips: toggle off ignores zone', () => {
  const manual: ManualSettings = {
    range_distance_pips: 30,
    use_signal_entry_range: false,
  }
  const r = resolveRangeDistancePips({ manual, parsed: zoneParsed, pip: 0.1, isBuy: true })
  assert.equal(r.source, 'manual')
  assert.equal(r.distPips, 30)
  assert.equal(r.boundary, null)
})

test('virtualLegTriggerAllowed: buy ladder stops at zone low', () => {
  assert.equal(virtualLegTriggerAllowed({ trigger: 4326, boundary: 4325, isBuy: true }), true)
  assert.equal(virtualLegTriggerAllowed({ trigger: 4325, boundary: 4325, isBuy: true }), true)
  assert.equal(virtualLegTriggerAllowed({ trigger: 4324.9, boundary: 4325, isBuy: true }), false)
})

test('virtualLegTriggerAllowed: sell ladder stops at zone high', () => {
  assert.equal(virtualLegTriggerAllowed({ trigger: 4334, boundary: 4335, isBuy: false }), true)
  assert.equal(virtualLegTriggerAllowed({ trigger: 4335, boundary: 4335, isBuy: false }), true)
  assert.equal(virtualLegTriggerAllowed({ trigger: 4335.1, boundary: 4335, isBuy: false }), false)
})

test('runtime clamp: buy anchor 4330 step 3 pips rejects legs past 4325', () => {
  const anchor = 4330
  const boundary = 4325
  const stepPriceOffset = 0.3 // 3 pips × 0.1
  const digits = 2
  let allowed = 0
  for (let stepIdx = 1; stepIdx <= 20; stepIdx++) {
    const trigger = triggerPriceFor({
      stepIdx,
      stepPriceOffset,
      isBuy: true,
      volume: 0.01,
      stoploss: null,
      takeprofit: null,
      slippage: 20,
      comment: 'test',
    }, anchor, digits)
    if (virtualPendingTriggerAllowed({
      triggerPrice: trigger,
      signalRangeBoundary: boundary,
      isBuy: true,
      stopsZoneLo: null,
      stopsZoneHi: null,
    })) {
      allowed += 1
    }
  }
  // span 5.0 / 0.3 = 16.66 → steps 1..16 allowed, 17+ rejected
  assert.equal(allowed, 16)
  const lastAllowed = triggerPriceFor({
    stepIdx: 16,
    stepPriceOffset,
    isBuy: true,
    volume: 0.01,
    stoploss: null,
    takeprofit: null,
    slippage: 20,
    comment: 'test',
  }, anchor, digits)
  assert.ok(lastAllowed >= boundary)
  const firstRejected = triggerPriceFor({
    stepIdx: 17,
    stepPriceOffset,
    isBuy: true,
    volume: 0.01,
    stoploss: null,
    takeprofit: null,
    slippage: 20,
    comment: 'test',
  }, anchor, digits)
  assert.ok(firstRejected < boundary)
})

test('signalRangeEntryQuoteAllowsImmediate: buy point price within tolerance', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: { ...zoneParsed, entry_price: 4505, entry_zone_low: null, entry_zone_high: null },
    isBuy: true,
  })!
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4500, ask: 4505.5, pipSize: 0.1 }),
    true,
  )
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4500, ask: 4506.5, pipSize: 0.1 }),
    false,
  )
})

test('signalRangeEntryQuoteAllowsImmediate: buy zone 4500-4505 full band matrix', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: 4500,
      entry_zone_high: 4505,
      sl: 4490,
      tp: [4510],
      lot_size: null,
    },
    isBuy: true,
  })!
  const pipSize = 0.1 // 10 pips → 1.0 tolerance
  // Above hi + tol (4506) → no trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4500, ask: 4506.01, pipSize }), false)
  // At hi + tol (4506) → trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4500, ask: 4506, pipSize }), true)
  // Inside zone → trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4498, ask: 4502, pipSize }), true)
  // At zone lo (4500) → trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4498, ask: 4500, pipSize }), true)
  // Below lo - tol (4499) → no trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4498, ask: 4498.99, pipSize }), false)
  // At lo - tol (4499) → trade
  assert.equal(signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4498, ask: 4499, pipSize }), true)
})

test('signalRangeEntryQuoteAllowsImmediate: buy zone band hi and lo bounds', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: zoneParsed,
    isBuy: true,
  })!
  const pipSize = 0.1
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4320, ask: 4335.5, pipSize }),
    true,
  )
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4320, ask: 4336.5, pipSize }),
    false,
  )
  // Mid-zone without touching either edge
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4320, ask: 4330, pipSize }),
    true,
  )
})

test('signalRangeEntryQuoteAllowsImmediate: sell zone band lo and hi bounds', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: zoneParsed,
    isBuy: false,
  })!
  const pipSize = 0.1
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4324.5, ask: 4340, pipSize }),
    true,
  )
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4323.5, ask: 4340, pipSize }),
    false,
  )
  // Mid-zone
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 4330, ask: 4340, pipSize }),
    true,
  )
})

test('signalRangeEntryQuoteAllowsImmediate: sell BTC zone 64203-64459 full band matrix', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: {
      action: 'sell',
      symbol: 'BTCUSD',
      entry_price: null,
      entry_zone_low: 64203,
      entry_zone_high: 64459,
      sl: 64659,
      tp: [64100],
      lot_size: null,
    },
    isBuy: false,
  })!
  const pipSize = 0.1
  // Inside zone
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64206.52, ask: 64225.948, pipSize }),
    true,
  )
  // At lo - tol (64202)
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64202, ask: 64220, pipSize }),
    true,
  )
  // Below lo - tol
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64201.5, ask: 64220, pipSize }),
    false,
  )
  // At hi + tol (64460)
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64460, ask: 64500, pipSize }),
    true,
  )
  // Above hi + tol
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64460.01, ask: 64500, pipSize }),
    false,
  )
})

test('signalRangeEntryQuoteAllowsImmediate: pip tolerance requires pipSize', () => {
  const wait = buildRangeEntryWait({
    manual: { use_signal_entry_range: true, range_trading: true, trade_style: 'multi', signal_entry_pip_tolerance: 10 },
    parsed: {
      action: 'sell',
      symbol: 'BTCUSD',
      entry_price: null,
      entry_zone_low: 64259,
      entry_zone_high: 64459,
      sl: 64659,
      tp: [64159],
      lot_size: null,
    },
    isBuy: false,
  })!
  // At zone low 64259, bid 64258.5 is within 10 pips (point=1) when pipSize is set.
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64258.5, ask: 64300, pipSize: 1 }),
    true,
  )
  assert.equal(
    signalRangeEntryQuoteAllowsImmediate({ wait, bid: 64258.5, ask: 64300 }),
    false,
  )
})
