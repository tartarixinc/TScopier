import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyChannelParamsToVirtualLeg,
  estimateBasketTotalPlannedLegs,
  isFullEntrySignalWithStops,
  mergeParsedWithChannelParams,
  parsedSignalHasExplicitStops,
  shouldMergeChannelParamsForEntry,
  shouldOverlayChannelParamsOnBasketRefresh,
  shouldPreferSignalStopsOverChannelMemory,
  shouldSeedChannelParamsFromEntrySignal,
  stripInvalidStopsForSide,
  symbolsForChannelParamsPersist,
  upsertChannelActiveTradeParams,
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

  test('shouldSeedChannelParamsFromEntrySignal blocks overwrite when basket is active', () => {
    assert.equal(shouldSeedChannelParamsFromEntrySignal(true), false)
    assert.equal(shouldSeedChannelParamsFromEntrySignal(false), true)
  })

  test('isFullEntrySignalWithStops: gold sell now zone with explicit SL and TPs', () => {
    assert.equal(
      isFullEntrySignalWithStops({
        action: 'sell',
        symbol: 'XAUUSD',
        entry_price: null,
        entry_zone_low: 4292,
        entry_zone_high: 4295,
        sl: 4299,
        tp: [4290, 4288, 4286],
        lot_size: null,
      }),
      true,
    )
  })

  test('full entry must not use stale channel SL from an older signal', () => {
    const newEntry = {
      action: 'sell' as const,
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: 4292,
      entry_zone_high: 4295,
      sl: 4299,
      tp: [4290, 4288, 4286],
      lot_size: null,
    }
    const staleChannel = { symbol: 'XAUUSD', stoploss: 4458, tpLevels: [4467, 4469, 4471] }
    assert.equal(isFullEntrySignalWithStops(newEntry), true)
    const gapFillOnly = mergeParsedWithChannelParams(newEntry, staleChannel)
    assert.equal(gapFillOnly.sl, 4299)
    assert.deepEqual(gapFillOnly.tp, [4290, 4288, 4286])
    const wouldStaleOverlay = mergeParsedWithChannelParams(newEntry, staleChannel, { overlay: true })
    assert.equal(wouldStaleOverlay.sl, 4458)
    assert.notEqual(wouldStaleOverlay.sl, newEntry.sl)
  })

  test('overlay keeps Adjust SL when a follow-up entry still carries template stops', () => {
    const out = mergeParsedWithChannelParams(
      {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 2500,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 2400,
        tp: [2600],
        lot_size: null,
      },
      { symbol: 'XAUUSD', stoploss: 2470, tpLevels: [2550, 2580] },
      { overlay: true },
    )
    assert.equal(out.sl, 2470)
    assert.deepEqual(out.tp, [2550, 2580])
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

  test('June 9 full sell @ 4309 prefers signal stops over June 5 channel memory', () => {
    const june9Entry = {
      action: 'sell' as const,
      symbol: 'XAUUSD',
      entry_price: 4309,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 4312,
      tp: [4303, 4301, 4299],
      lot_size: null,
    }
    const june5Channel = {
      symbol: 'XAUUSD',
      stoploss: 4315,
      tpLevels: [4306, 4304, 4300],
    }
    assert.equal(shouldPreferSignalStopsOverChannelMemory(june9Entry), true)
    assert.equal(isFullEntrySignalWithStops(june9Entry), true)
    const gapFill = mergeParsedWithChannelParams(june9Entry, june5Channel)
    assert.equal(gapFill.sl, 4312)
    assert.deepEqual(gapFill.tp, [4303, 4301, 4299])
    assert.equal(
      shouldOverlayChannelParamsOnBasketRefresh(june9Entry, 'signal_merge_into_open_trade'),
      false,
    )
  })

  test('shouldOverlayChannelParamsOnBasketRefresh allows overlay for parameter follow-ups', () => {
    const slTpOnly = {
      action: 'sell' as const,
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 4312,
      tp: [4303, 4301, 4299],
      lot_size: null,
    }
    assert.equal(shouldPreferSignalStopsOverChannelMemory(slTpOnly), false)
    assert.equal(
      shouldOverlayChannelParamsOnBasketRefresh(slTpOnly, 'signal_merge_into_open_trade'),
      true,
    )
    assert.equal(
      shouldOverlayChannelParamsOnBasketRefresh(slTpOnly, 'merge_routed_modify_only'),
      false,
    )
  })

  test('upsertChannelActiveTradeParams replace overwrites stale June 5 row', async () => {
    const upserted: Record<string, unknown>[] = []
    const chain = {
      eq: () => chain,
      limit: () => Promise.resolve({
        data: [{ symbol: 'XAUUSD', stoploss: 4315, tp_levels: [4306, 4304, 4300] }],
        error: null,
      }),
    }
    const mockSupabase = {
      from: () => ({
        select: () => chain,
        upsert: (row: Record<string, unknown>) => {
          upserted.push(row)
          return Promise.resolve({ error: null })
        },
      }),
    }
    await upsertChannelActiveTradeParams(mockSupabase as never, {
      userId: 'user-1',
      channelId: 'channel-1',
      symbols: ['XAUUSD'],
      stoploss: 4312,
      tpLevels: [4303, 4301, 4299],
      replace: true,
    })
    assert.equal(upserted.length, 1)
    assert.equal(upserted[0]!.stoploss, 4312)
    assert.deepEqual(upserted[0]!.tp_levels, [4303, 4301, 4299])
  })

  test('upsertChannelActiveTradeParams without replace merges partial updates', async () => {
    const upserted: Record<string, unknown>[] = []
    const chain = {
      eq: () => chain,
      limit: () => Promise.resolve({
        data: [{ symbol: 'XAUUSD', stoploss: 4315, tp_levels: [4306, 4304, 4300] }],
        error: null,
      }),
    }
    const mockSupabase = {
      from: () => ({
        select: () => chain,
        upsert: (row: Record<string, unknown>) => {
          upserted.push(row)
          return Promise.resolve({ error: null })
        },
      }),
    }
    await upsertChannelActiveTradeParams(mockSupabase as never, {
      userId: 'user-1',
      channelId: 'channel-1',
      symbols: ['XAUUSD'],
      stoploss: 4312,
      tpLevels: [],
      replace: false,
    })
    assert.equal(upserted[0]!.stoploss, 4312)
    assert.deepEqual(upserted[0]!.tp_levels, [4306, 4304, 4300])
  })
})
