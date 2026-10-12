import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveChosenTakeProfit,
  shouldApplySingleTakeProfitTarget,
} from './partialTpSchedule'
import { expandPerLegTargetsToCount } from './tpBucketDistribution'
import { stopsAlreadyMatchDb } from '../orderModifyBenign'
const ladder = [4090, 4085, 4080, 4075]
describe('resolveChosenTakeProfit', () => {
  it('returns the requested rung of the ladder', () => {
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: 'tp2' }), 4085)
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: 'tp4' }), 4075)
  })
  it('clamps a rung that is deeper than the ladder', () => {
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: 'tp9' }), 4075)
  })
  it('defaults to the last rung when no target is selected', () => {
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder }), 4075)
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: null }), 4075)
  })
  it('picks by price extreme when farthest is selected', () => {
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: 'farthest', isBuy: true }), 4090)
    assert.equal(resolveChosenTakeProfit({ finalTps: ladder, singleTpTarget: 'farthest', isBuy: false }), 4075)
  })
  it('returns 0 when the ladder is empty', () => {
    assert.equal(resolveChosenTakeProfit({ finalTps: [] }), 0)
    assert.equal(resolveChosenTakeProfit({ finalTps: [Number.NaN] }), 0)
  })
})
describe('shouldApplySingleTakeProfitTarget', () => {
  it('is true only for single trade style', () => {
    assert.equal(shouldApplySingleTakeProfitTarget({ trade_style: 'single' }), true)
    assert.equal(shouldApplySingleTakeProfitTarget({ trade_style: 'multi' }), false)
    assert.equal(shouldApplySingleTakeProfitTarget({ trade_style: null }), false)
    assert.equal(shouldApplySingleTakeProfitTarget(null), false)
  })
})
describe('expandPerLegTargetsToCount chosen take profit', () => {
  it('pins every leg to the chosen rung when enough targets exist', () => {
    const out = expandPerLegTargetsToCount({
      targets: [
        { stoploss: 4105, takeprofit: 4090 },
        { stoploss: 4105, takeprofit: 4085 },
      ],
      openLegCount: 2,
      finalTps: ladder,
      chosenTp: 4080,
    })
    assert.deepEqual(out, [
      { stoploss: 4105, takeprofit: 4080 },
      { stoploss: 4105, takeprofit: 4080 },
    ])
  })
  it('pins every leg when fewer targets exist than open legs', () => {
    const out = expandPerLegTargetsToCount({
      targets: [{ stoploss: 4105, takeprofit: 4090 }],
      openLegCount: 3,
      finalTps: ladder,
      chosenTp: 4080,
    })
    assert.equal(out.length, 3)
    for (const leg of out) {
      assert.equal(leg.takeprofit, 4080)
      assert.equal(leg.stoploss, 4105)
    }
  })
  it('does not pin legs when no chosen rung is set', () => {
    const out = expandPerLegTargetsToCount({
      targets: [{ stoploss: 4105, takeprofit: 0 }],
      openLegCount: 2,
      finalTps: ladder,
    })
    assert.equal(out.length, 2)
    assert.ok(
      out.every(leg => leg.takeprofit !== 4080),
      `legs must not be pinned to 4080: ${JSON.stringify(out)}`,
    )
  })
  it('ignores a non-positive chosen rung', () => {
    const out = expandPerLegTargetsToCount({
      targets: [{ stoploss: 4105, takeprofit: 4090 }],
      openLegCount: 2,
      finalTps: ladder,
      chosenTp: 0,
    })
    assert.equal(out.length, 2)
    assert.equal(out[0]!.takeprofit, 4090)
  })
})
describe('stopsAlreadyMatchDb requireTakeProfit', () => {
  it('treats a zero target with no broker TP as already matching by default', () => {
    assert.equal(
      stopsAlreadyMatchDb(
        { sl: 4105, tp: null },
        { stoploss: 4105, takeprofit: 0 },
        0,
        0,
      ),
      true,
    )
  })
  it('does not treat it as matching when a take profit is required', () => {
    assert.equal(
      stopsAlreadyMatchDb(
        { sl: 4105, tp: null },
        { stoploss: 4105, takeprofit: 0 },
        0,
        0,
        1e-8,
        { requireTakeProfit: true },
      ),
      false,
    )
  })
  it('still accepts a leg whose broker TP equals the chosen rung', () => {
    assert.equal(
      stopsAlreadyMatchDb(
        { sl: 4105, tp: 4080 },
        { stoploss: 4105, takeprofit: 4080 },
        0,
        0,
        1e-8,
        { requireTakeProfit: true },
      ),
      true,
    )
  })
})
