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

test('shouldRouteAsBasketParameterRefresh: priced entry + SL/TP is fresh entry', () => {
  assert.equal(
    shouldRouteAsBasketParameterRefresh({
      action: 'sell',
      entry_price: 4550,
      sl: 4570,
      tp: [4530, 4510, 4490],
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
  })
  assert.equal(targets.length, 4)
  assert.equal(targets[0]!.takeprofit, 200)
  assert.equal(targets[3]!.takeprofit, 300)
})

test('buildPerLegStopTargets: parsed fallback when plan has no immediates', () => {
  const plan: PlannerResult = { orders: [], delay_ms: 0, virtualPendings: [] }
  const targets = buildPerLegStopTargets({
    plan,
    parsed: { sl: 78100, tp: [79300, 79600, 80100] },
    openLegCount: 3,
  })
  assert.equal(targets.length, 3)
  assert.equal(targets[0]!.stoploss, 78100)
  assert.equal(targets[2]!.takeprofit, 80100)
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
