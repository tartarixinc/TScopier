import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyChannelParamsToVirtualLeg,
  estimateBasketTotalPlannedLegs,
  mergeParsedWithChannelParams,
  parsedSignalHasExplicitStops,
  shouldMergeChannelParamsForEntry,
  stripInvalidStopsForSide,
  symbolsForChannelParamsPersist,
} from './channelActiveTradeParams'

describe('channelActiveTradeParams', () => {
  test('mergeParsedWithChannelParams fills gaps only by default', () => {
    const out = mergeParsedWithChannelParams(
      {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 4500,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 4400,
        tp: [4600, 4650],
        lot_size: null,
      },
      { symbol: 'XAUUSD', stoploss: 4470, tpLevels: [4550, 4620] },
    )
    assert.equal(out.sl, 4400)
    assert.deepEqual(out.tp, [4600, 4650])
  })

  test('mergeParsedWithChannelParams overlay replaces explicit stops', () => {
    const out = mergeParsedWithChannelParams(
      {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 4500,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 4400,
        tp: [4600],
        lot_size: null,
      },
      { symbol: 'XAUUSD', stoploss: 4470, tpLevels: [4550, 4620] },
      { overlay: true },
    )
    assert.equal(out.sl, 4470)
    assert.deepEqual(out.tp, [4550, 4620])
  })

  test('mergeParsedWithChannelParams fills missing SL/TP from channel memory', () => {
    const out = mergeParsedWithChannelParams(
      {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 4500,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: null,
        lot_size: null,
      },
      { symbol: 'XAUUSD', stoploss: 4470, tpLevels: [4550, 4620] },
    )
    assert.equal(out.sl, 4470)
    assert.deepEqual(out.tp, [4550, 4620])
  })

  test('applyChannelParamsToVirtualLeg distributes TP within range pool only', () => {
    const out = applyChannelParamsToVirtualLeg(
      { stoploss: 4400, takeprofit: 4600 },
      { symbol: 'XAUUSD', stoploss: 4470, tpLevels: [4530, 4510, 4490] },
      {
        rangeLegIndex: 3,
        rangeLegCount: 5,
        tpLots: [
          { label: 'TP1', lot: 0, percent: 50, enabled: true },
          { label: 'TP2', lot: 0, percent: 30, enabled: true },
          { label: 'TP3', lot: 0, percent: 20, enabled: true },
        ],
      },
    )
    assert.equal(out.stoploss, 4470)
    assert.equal(out.takeprofit, 4510)
  })

  test('estimateBasketTotalPlannedLegs accounts for fired range legs', () => {
    assert.equal(
      estimateBasketTotalPlannedLegs({
        openLegCount: 7,
        activePendingCount: 3,
        maxPendingStepIdx: 5,
      }),
      10,
    )
  })

  test('shouldMergeChannelParamsForEntry requires explicit signal stops', () => {
    assert.equal(
      shouldMergeChannelParamsForEntry({
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 3300,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: null,
        lot_size: null,
      }),
      false,
    )
    assert.equal(
      shouldMergeChannelParamsForEntry({
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 3300,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 3270,
        tp: null,
        lot_size: null,
      }),
      true,
    )
    assert.equal(parsedSignalHasExplicitStops({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [3350],
      lot_size: null,
    }), true)
  })

  test('stripInvalidStopsForSide removes buy SL above market', () => {
    const out = stripInvalidStopsForSide({
      stoploss: 3400,
      takeprofit: 3500,
      referencePrice: 3300,
      isBuy: true,
    })
    assert.equal(out.stoploss, 0)
    assert.equal(out.takeprofit, 3500)
    assert.equal(out.stripped.length, 1)
  })

  test('symbolsForChannelParamsPersist dedupes hints and trade symbols', () => {
    const syms = symbolsForChannelParamsPersist({
      symbolFromText: 'GOLD',
      tradeSymbols: ['XAUUSD', 'XAUUSD'],
      pendingSymbols: ['XAUUSDm'],
    })
    assert.ok(syms.includes('GOLD'))
    assert.ok(syms.includes('XAUUSD'))
    assert.ok(syms.includes('XAUUSDm'))
  })
})
