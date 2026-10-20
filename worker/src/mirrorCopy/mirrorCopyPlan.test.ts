import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { NormalizedSourcePosition } from '../copyShared/copyHelpers'
import { DEFAULT_MIRROR_COPY_SETTINGS, parseMirrorCopySettings } from './mirrorCopyTypes'
import {
  directionAllows,
  mirrorCopyStops,
  mirrorCopySymbol,
  mirrorCopyVolume,
  planMirrorCopy,
} from './mirrorCopyPlan'

function position(overrides: Partial<NormalizedSourcePosition> = {}): NormalizedSourcePosition {
  return {
    ticket: '1', symbol: 'EURUSD', side: 'buy', volume: 0.10,
    stopLoss: 1.0800, takeProfit: 1.1000, ...overrides,
  }
}

/** The shape the app actually writes into broker_copy_links.manual_settings. */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copy_risk: {
      sizing: { mode: 'lot_multiplier', fixed_lot: 0.01, lot_multiplier: 1, min_lot: 0.01, max_lot: null },
      stops: { copy_source_sl: true, copy_source_tp: true },
      filters: { direction: 'both' },
    },
    risk_mode: 'fixed_lot',
    fixed_lot: 0.01,
    dynamic_balance_percent: 1,
    ...overrides,
  }
}

test('unconfigured or garbage settings fail closed rather than guessing a size', () => {
  for (const raw of [undefined, null, 'nonsense', [], {}]) {
    const settings = parseMirrorCopySettings(raw)
    assert.equal(settings.sizingMode, 'unsupported')
    assert.deepEqual(settings, DEFAULT_MIRROR_COPY_SETTINGS)
  }
  assert.equal(planMirrorCopy(DEFAULT_MIRROR_COPY_SETTINGS, position()), null)
})

test('reads the real copy_risk.sizing shape for both supported modes', () => {
  const multiplier = parseMirrorCopySettings(stored())
  assert.equal(multiplier.sizingMode, 'lot_multiplier')
  assert.equal(multiplier.lotMultiplier, 1)

  const fixed = parseMirrorCopySettings(stored({
    copy_risk: { sizing: { mode: 'fixed_lot', fixed_lot: 0.25, max_lot: 2 }, stops: {}, filters: {} },
  }))
  assert.equal(fixed.sizingMode, 'fixed_lot')
  assert.equal(fixed.fixedLot, 0.25)
  assert.equal(fixed.maxLot, 2)
})

test('unimplemented sizing modes become unsupported (no silent 1x copy)', () => {
  for (const mode of ['equity_ratio', 'balance_ratio', 'percent_risk', 'cash_risk', 'stop_distance']) {
    const settings = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode } } }))
    assert.equal(settings.sizingMode, 'unsupported', mode)
    assert.equal(mirrorCopyVolume(settings, 1), null, mode)
  }
  const fixedWithoutSize = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'fixed_lot' } } }))
  assert.equal(fixedWithoutSize.sizingMode, 'unsupported')
})

test('falls back to the legacy top-level sizing only for a supported fixed_lot', () => {
  const legacy = parseMirrorCopySettings({ risk_mode: 'fixed_lot', fixed_lot: 0.5 })
  assert.equal(legacy.sizingMode, 'fixed_lot')
  assert.equal(legacy.fixedLot, 0.5)

  const dynamic = parseMirrorCopySettings({ risk_mode: 'dynamic_balance_percent', dynamic_balance_percent: 2 })
  assert.equal(dynamic.sizingMode, 'unsupported')
})

test('applies the max_lot cap inside the plan so the cap holds for any caller', () => {
  const settings = parseMirrorCopySettings(stored({
    copy_risk: { sizing: { mode: 'lot_multiplier', lot_multiplier: 3, max_lot: 1 } },
  }))
  assert.equal(mirrorCopyVolume(settings, 0.5), 1)
  assert.equal(mirrorCopyVolume(settings, 0.25), 0.75)
})

test('volume fails closed on unusable source volume and rejects a non-positive multiplier', () => {
  assert.equal(mirrorCopyVolume(DEFAULT_MIRROR_COPY_SETTINGS, 0), null)
  assert.equal(mirrorCopyVolume(DEFAULT_MIRROR_COPY_SETTINGS, -1), null)
  assert.equal(mirrorCopyVolume(DEFAULT_MIRROR_COPY_SETTINGS, Number.NaN), null)
  assert.equal(mirrorCopyVolume(DEFAULT_MIRROR_COPY_SETTINGS, Number.POSITIVE_INFINITY), null)
  // lot_multiplier <= 0 is unsupported (fail closed), matching the app's 0x intent.
  assert.equal(parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier', lot_multiplier: 0 } } })).sizingMode, 'unsupported')
})

test('the common app default row (legacy fixed_lot 0.01) copies at 0.01', () => {
  const settings = parseMirrorCopySettings({ risk_mode: 'fixed_lot', fixed_lot: 0.01, dynamic_balance_percent: 1 })
  assert.equal(settings.sizingMode, 'fixed_lot')
  assert.equal(planMirrorCopy(settings, position())?.requestedVolume, 0.01)
})

test('max_lot caps fixed_lot mode too, and per-symbol overrides apply before the cap', () => {
  const fixed = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'fixed_lot', fixed_lot: 2, max_lot: 1 } } }))
  assert.equal(mirrorCopyVolume(fixed, 0.1), 1)

  const overrides = parseMirrorCopySettings(stored({
    copy_risk: { sizing: { mode: 'lot_multiplier', lot_multiplier: 1, max_lot: 0.5, symbol_overrides: [{ symbol: 'xauusd', fixed_lot: 5 }] } },
  }))
  assert.equal(mirrorCopyVolume(overrides, 0.10, 'XAUUSD'), 0.5)
  assert.equal(mirrorCopyVolume(overrides, 0.10, 'EURUSD'), 0.1)
})

test('safety controls the app writes block copying (fail closed)', () => {
  const emergency = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, protection: { emergency_stop: true } } }))
  assert.equal(emergency.emergencyStop, true)
  assert.equal(planMirrorCopy(emergency, position()), null)

  const paused = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, lifecycle: { pause_new: true } } }))
  assert.equal(planMirrorCopy(paused, position()), null)

  const requireStop = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, filters: { require_stop: true } } }))
  assert.equal(planMirrorCopy(requireStop, position({ stopLoss: null })), null)
  assert.ok(planMirrorCopy(requireStop, position({ stopLoss: 1.08 })))

  const volumeFilter = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, filters: { min_source_volume: 0.2, max_source_volume: 1 } } }))
  assert.equal(planMirrorCopy(volumeFilter, position({ volume: 0.1 })), null)
  assert.equal(planMirrorCopy(volumeFilter, position({ volume: 2 })), null)
  assert.ok(planMirrorCopy(volumeFilter, position({ volume: 0.5 })))
})

test('account lock and order-type filters block copying', () => {
  const locked = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, lifecycle: { account_locked: true } } }))
  assert.equal(locked.accountLocked, true)
  assert.equal(planMirrorCopy(locked, position()), null)

  const noMarket = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, filters: { order_types: ['limit', 'stop'] } } }))
  assert.equal(planMirrorCopy(noMarket, position()), null)

  const market = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, filters: { order_types: ['market'] } } }))
  assert.ok(planMirrorCopy(market, position()))
})

test('symbol overrides key on the mapped destination symbol', () => {
  const settings = parseMirrorCopySettings(stored({
    symbol_mapping: { eurusd: 'eurusd.r' },
    copy_risk: { sizing: { mode: 'lot_multiplier', lot_multiplier: 1, symbol_overrides: [{ symbol: 'eurusd.r', fixed_lot: 0.5 }] } },
  }))
  assert.equal(planMirrorCopy(settings, position())?.requestedVolume, 0.5)
})

test('direction filter reads copy_risk.filters.direction', () => {
  const buyOnly = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, filters: { direction: 'buy' } } }))
  assert.equal(buyOnly.directionFilter, 'buy')
  assert.equal(directionAllows(buyOnly, 'buy'), true)
  assert.equal(directionAllows(buyOnly, 'sell'), false)
  assert.equal(planMirrorCopy(buyOnly, position({ side: 'sell' })), null)
  assert.ok(planMirrorCopy(buyOnly, position({ side: 'buy' })))
})

test('stop toggles read copy_risk.stops.copy_source_sl / copy_source_tp', () => {
  const settings = parseMirrorCopySettings(stored({
    copy_risk: { sizing: { mode: 'lot_multiplier' }, stops: { copy_source_sl: false, copy_source_tp: true } },
  }))
  assert.equal(settings.copyStopLoss, false)
  assert.deepEqual(mirrorCopyStops(settings, position()), { stopLoss: null, takeProfit: 1.10 })

  const numeric = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'lot_multiplier' }, stops: { copy_source_sl: 0 } } }))
  assert.equal(numeric.copyStopLoss, false)
})

test('symbol_mapping uppercases keys and values, and falls through trimmed on a miss', () => {
  const settings = parseMirrorCopySettings(stored({ symbol_mapping: { eurusd: 'eurusd.r', xauusd: 'gold' } }))
  assert.deepEqual(settings.symbolMap, { EURUSD: 'EURUSD.R', XAUUSD: 'GOLD' })
  assert.equal(mirrorCopySymbol(settings, ' eurusd '), 'EURUSD.R')
  assert.equal(mirrorCopySymbol(settings, ' gbpusd '), 'gbpusd')
})

test('readNumber rejects booleans and arrays so they cannot mis-size a trade', () => {
  const asBool = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'fixed_lot', fixed_lot: true } } }))
  assert.equal(asBool.sizingMode, 'unsupported', 'true must not become a 1-lot trade')

  const asArray = parseMirrorCopySettings(stored({ copy_risk: { sizing: { mode: 'fixed_lot', fixed_lot: [0.5] } } }))
  assert.equal(asArray.sizingMode, 'unsupported')
})

test('planMirrorCopy combines symbol, side, size and stops for a configured link', () => {
  const settings = parseMirrorCopySettings(stored({
    symbol_mapping: { eurusd: 'eurusd.r' },
    copy_risk: { sizing: { mode: 'lot_multiplier', lot_multiplier: 2 }, stops: { copy_source_sl: true, copy_source_tp: false } },
  }))
  assert.deepEqual(planMirrorCopy(settings, position()), {
    symbol: 'EURUSD.R', side: 'buy', requestedVolume: 0.2, stopLoss: 1.08, takeProfit: null,
  })
})
