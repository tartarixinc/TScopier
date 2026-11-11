import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  deriveManualStopsWithClamp,
  mirrorParsedAbsoluteStopsForReverse,
  resolvePredefinedSlForEntry,
  resolvePredefinedTpForEntry,
} from './manualStops'

test('mirrorParsedAbsoluteStopsForReverse: reflects price-unit SL/TP and leaves pip offsets', () => {
  const entry = 2000
  const mirrored = mirrorParsedAbsoluteStopsForReverse({
    action: 'buy',
    symbol: 'XAUUSD',
    entry_price: entry,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: 1990,
    tp: [2010, 2020],
    lot_size: null,
  }, entry, null)
  assert.equal(mirrored.sl, 2010)
  assert.deepEqual(mirrored.tp, [1990, 1980])

  const pipStops = mirrorParsedAbsoluteStopsForReverse({
    action: 'buy',
    symbol: 'XAUUSD',
    entry_price: entry,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: 80,
    tp: [50],
    sl_unit: 'pips',
    tp_unit: 'pips',
    lot_size: null,
  }, entry, null)
  assert.equal(pipStops.sl, 80)
  assert.deepEqual(pipStops.tp, [50])
})

test('resolvePredefinedTpForEntry: 30 pips from fill, even when shared TP would be dropped', () => {
  const manual = { use_predefined_tp_pips: true as const, predefined_tp_pips: [30] }
  const buyFill = 2005
  const sharedBuyTp = 2003
  const buyTp = resolvePredefinedTpForEntry({
    manual,
    entry: buyFill,
    isBuy: true,
    symbol: 'XAUUSD',
    point: 0.01,
    digits: 2,
    contractSize: 100,
    existingTp: sharedBuyTp,
    matchEntry: 2000,
  })
  assert.equal(buyTp, 2008)
  assert.ok(buyTp! > buyFill)
  assert.ok(!(sharedBuyTp > buyFill), 'shared basket TP sits on the wrong side of this fill')

  const sellFill = 1990
  const sharedSellTp = 1997
  const sellTp = resolvePredefinedTpForEntry({
    manual,
    entry: sellFill,
    isBuy: false,
    symbol: 'XAUUSD',
    point: 0.01,
    digits: 2,
    contractSize: 100,
    existingTp: sharedSellTp,
    matchEntry: 2000,
  })
  assert.equal(sellTp, 1987)
  assert.ok(sellTp! < sellFill)
})

test('resolvePredefinedTpForEntry: keeps TP2 bucket from planned ladder', () => {
  const tp = resolvePredefinedTpForEntry({
    manual: { use_predefined_tp_pips: true, predefined_tp_pips: [30, 50] },
    entry: 1990,
    isBuy: true,
    symbol: 'XAUUSD',
    point: 0.01,
    digits: 2,
    contractSize: 100,
    existingTp: 2005,
    matchEntry: 2000,
  })
  assert.equal(tp, 1995)
})

const baseCtx = {
  point: 0.0001,
  digits: 5,
  minLot: 0.01,
  lotStep: 0.01,
  contractSize: null,
  stopsLevel: 0,
  freezeLevel: 0,
  defaultLot: 0.01,
  lastBalance: 10000,
}

test('deriveManualStopsWithClamp: predefined SL ignores signal SL price', () => {
  const entry = 1.1
  const signalSl = 1.095
  const { finalSl, pip } = deriveManualStopsWithClamp({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: signalSl,
      tp: [1.12],
      lot_size: null,
    },
    manual: {
      use_predefined_sl_pips: true,
      predefined_sl_pips: 30,
      use_predefined_tp_pips: false,
    },
    channelKeywords: null,
    resolvedSymbol: 'EURUSD',
    ctx: baseCtx,
    entryAnchor: entry,
    isBuy: true,
  })
  const expected = Number((entry - 30 * pip).toFixed(5))
  assert.ok(finalSl != null)
  assert.equal(Number(finalSl.toFixed(5)), expected)
  assert.notEqual(finalSl, signalSl)
})

test('deriveManualStopsWithClamp: predefined TP ignores signal TP prices', () => {
  const entry = 1.1
  const { finalTps, pip } = deriveManualStopsWithClamp({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 1.07,
      tp: [1.5, 1.6],
      lot_size: null,
    },
    manual: {
      use_predefined_sl_pips: false,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [20, 40],
    },
    channelKeywords: null,
    resolvedSymbol: 'EURUSD',
    ctx: baseCtx,
    entryAnchor: entry,
    isBuy: true,
  })
  assert.equal(finalTps.length, 2)
  assert.equal(Number(finalTps[0]!.toFixed(5)), Number((entry + 20 * pip).toFixed(5)))
  assert.equal(Number(finalTps[1]!.toFixed(5)), Number((entry + 40 * pip).toFixed(5)))
  assert.notEqual(Number(finalTps[0]!.toFixed(5)), 1.5)
})

test('resolvePredefinedSlForEntry: 80 pips from fill, even when shared SL would be dropped', () => {
  const manual = { use_predefined_sl_pips: true as const, predefined_sl_pips: 80 }
  const buyFill = 1990
  const sharedBuySl = 1992
  const buySl = resolvePredefinedSlForEntry({
    manual,
    entry: buyFill,
    isBuy: true,
    symbol: 'XAUUSD',
    point: 0.01,
    digits: 2,
    contractSize: 100,
  })
  assert.equal(buySl, 1982)
  assert.ok(buySl! < buyFill)
  assert.ok(!(sharedBuySl < buyFill), 'shared basket SL sits on the wrong side of this fill')

  const sellFill = 2010
  const sharedSellSl = 2008
  const sellSl = resolvePredefinedSlForEntry({
    manual,
    entry: sellFill,
    isBuy: false,
    symbol: 'XAUUSD',
    point: 0.01,
    digits: 2,
    contractSize: 100,
  })
  assert.equal(sellSl, 2018)
  assert.ok(sellSl! > sellFill)
  assert.ok(!(sharedSellSl > sellFill), 'shared basket SL sits on the wrong side of this fill')
})

