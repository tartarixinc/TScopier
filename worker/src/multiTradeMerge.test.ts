import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildPerLegStopTargets,
  isBareEntryFollowUp,
  isParameterFollowUpSignal,
  mergePlanImmediateOrders,
  parsedHasSlOrTp,
  shouldRouteAsBasketParameterRefresh,
} from './multiTradeMerge'
import type { PlannerResult } from './manualPlanner'

test('isParameterFollowUpSignal: SL only', () => {
  assert.equal(isParameterFollowUpSignal({ sl: 78100, tp: null }), true)
})

test('isParameterFollowUpSignal: TP only', () => {
  assert.equal(isParameterFollowUpSignal({ sl: null, tp: [79300, 79600] }), true)
})

test('isParameterFollowUpSignal: bare buy now', () => {
  assert.equal(isParameterFollowUpSignal({ action: 'buy', sl: null, tp: null }), false)
})

test('parsedHasSlOrTp aliases isParameterFollowUpSignal', () => {
  assert.equal(parsedHasSlOrTp({ sl: 100, tp: null }), true)
  assert.equal(parsedHasSlOrTp({ action: 'buy', sl: null, tp: null }), false)
})

test('shouldRouteAsBasketParameterRefresh: priced entry + SL/TP is parameter refresh', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({
      action: 'sell',
      entry_price: 4550,
      sl: 4570,
      tp: [4530, 4510, 4490],
    }),
    true,
  )
})

test('shouldRouteAsBasketParameterRefresh: re-enter bypasses parameter refresh', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({
      action: 'sell',
      entry_price: 4567,
      sl: 4577,
      tp: [4564, 4527],
      re_enter: true,
    }),
    false,
  )
})

test('shouldRouteAsBasketParameterRefresh: bare NOW is not parameter refresh', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({ action: 'sell', sl: null, tp: null }),
    false,
  )
  assert.equal(isBareEntryFollowUp({ action: 'sell', sl: null, tp: null }), true)
})

test('shouldRouteAsBasketParameterRefresh: SL/TP without entry is follow-up candidate', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({
      action: 'sell',
      sl: 4570,
      tp: [4530, 4510],
    }),
    true,
  )
})

test('shouldRouteAsBasketParameterRefresh: full entry with zone and stops is parameter refresh', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({
      action: 'sell',
      symbol: 'XAUUSD',
      entry_zone_low: 4292,
      entry_zone_high: 4295,
      sl: 4299,
      tp: [4290, 4288, 4286],
    }),
    true,
  )
})

test('shouldRouteAsBasketParameterRefresh: modify with SL', () => {
  assert.equal(shouldRouteAsBasketParameterRefresh({ action: 'modify', sl: 100, tp: null }), true)
})

test('buildPerLegStopTargets: extends planner rows to every open leg', () => {
  const plan: PlannerResult = {
    orders: [
      { symbol: 'BTCUSD', operation: 'Buy', volume: 0.01, price: 0, stoploss: 100, takeprofit: 200, slippage: 20, comment: 'a', expertID: 1 },
      { symbol: 'BTCUSD', operation: 'Buy', volume: 0.01, price: 0, stoploss: 100, takeprofit: 300, slippage: 20, comment: 'b', expertID: 1 },
    ],
    delay_ms: 0,
  }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 100, tp: [200, 300] },
    openLegCount: 4,
    totalPlannedLegCount: 4,
    immediateLegCount: 2,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  })
  assert.equal(targets.length, 4)
  assert.equal(targets[0]!.takeprofit, 200)
  assert.equal(targets[1]!.takeprofit, 300)
  assert.equal(targets[2]!.takeprofit, 200)
  assert.equal(targets[3]!.takeprofit, 300)
})

test('buildPerLegStopTargets: parsed fallback when plan has no immediates', () => {
  const plan: PlannerResult = { orders: [], delay_ms: 0, virtualPendings: [] }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 78100, tp: [79300, 79600, 80100] },
    openLegCount: 3,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 34, enabled: true },
      { label: 'TP2', lot: 0, percent: 33, enabled: true },
      { label: 'TP3', lot: 0, percent: 33, enabled: true },
    ],
  })
  assert.equal(targets.length, 3)
  assert.equal(targets[0]!.stoploss, 78100)
  assert.equal(targets[0]!.takeprofit, 79300)
  assert.equal(targets[1]!.takeprofit, 79600)
  assert.equal(targets[2]!.takeprofit, 80100)
})

test('buildPerLegStopTargets: never clones last immediate TP when open legs exceed plan.orders', () => {
  const plan: PlannerResult = {
    orders: [
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4530, slippage: 20, comment: 'tp1', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4530, slippage: 20, comment: 'tp1', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4510, slippage: 20, comment: 'tp2', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4490, slippage: 20, comment: 'tp3', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4490, slippage: 20, comment: 'tp3', expertID: 1 },
    ],
    delay_ms: 0,
  }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 4570, tp: [4530, 4510, 4490] },
    openLegCount: 10,
    totalPlannedLegCount: 10,
    immediateLegCount: 5,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(targets.length, 10)
  assert.equal(targets.filter(t => t.takeprofit === 4490).length, 0)
  assert.equal(targets.filter(t => t.takeprofit === 4530).length, 6)
  assert.equal(targets.filter(t => t.takeprofit === 4510).length, 4)
})

test('buildPerLegStopTargets: spreads TPs by Targets % when plan has fewer immediates than legs', () => {
  const plan: PlannerResult = {
    orders: [
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4530, slippage: 20, comment: 'a', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4510, slippage: 20, comment: 'b', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4490, slippage: 20, comment: 'c', expertID: 1 },
    ],
    delay_ms: 0,
  }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 4570, tp: [4530, 4510, 4490] },
    openLegCount: 10,
    totalPlannedLegCount: 10,
    immediateLegCount: 3,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(targets.length, 10)
  assert.equal(targets.filter(t => t.takeprofit === 4530).length, 6)
  assert.equal(targets.filter(t => t.takeprofit === 4510).length, 3)
  assert.equal(targets.filter(t => t.takeprofit === 4490).length, 1)
})

test('buildPerLegStopTargets: split pools keep instant vs range TP slots', () => {
  const plan: PlannerResult = {
    orders: [
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4530, slippage: 20, comment: 'a', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4510, slippage: 20, comment: 'b', expertID: 1 },
      { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01, price: 0, stoploss: 4570, takeprofit: 4490, slippage: 20, comment: 'c', expertID: 1 },
    ],
    delay_ms: 0,
    virtualPendings: [],
  }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 4570, tp: [4530, 4510, 4490] },
    openLegCount: 3,
    totalPlannedLegCount: 10,
    immediateLegCount: 3,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(targets.length, 3)
  assert.equal(targets[0]!.takeprofit, 4530)
  assert.equal(targets[1]!.takeprofit, 4530)
  assert.equal(targets[2]!.takeprofit, 4510)
})

test('buildPerLegStopTargets: message-edit refresh treats all open legs as immediate', () => {
  const plan: PlannerResult = { orders: [], delay_ms: 0, virtualPendings: [] }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 4524.3, tp: [4535, 4538] },
    openLegCount: 2,
    totalPlannedLegCount: 5,
    immediateLegCount: 2,
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  })
  assert.equal(targets.length, 2)
  assert.equal(targets[0]!.stoploss, 4524.3)
  assert.equal(targets[1]!.stoploss, 4524.3)
  assert.equal(targets[0]!.takeprofit, 4535)
  assert.equal(targets[1]!.takeprofit, 4538)
})

test('mergePlanImmediateOrders: includes limits', () => {
  const plan: PlannerResult = {
    orders: [
      { symbol: 'X', operation: 'BuyLimit', volume: 0.01, price: 1, stoploss: 0, takeprofit: 0, slippage: 20, comment: '', expertID: 1 },
    ],
    delay_ms: 0,
  }
  assert.equal(mergePlanImmediateOrders(plan).length, 1)
})
