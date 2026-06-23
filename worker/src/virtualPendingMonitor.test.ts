import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  evaluateTpTouch,
  fillWithinTriggerBand,
  isTriggered,
  shouldLockBasketLayering,
} from './virtualPendingMonitor'

// Buy ladder = averaging DOWN: trigger fires when bid drops to / below trigger_price.
test('isTriggered: buy fires when bid <= trigger', () => {
  assert.equal(isTriggered(true, 1840, 1839.5, 1839.6), true)
  assert.equal(isTriggered(true, 1840, 1840, 1840.1), true)   // exactly at trigger
})

test('isTriggered: buy does NOT fire when bid > trigger', () => {
  assert.equal(isTriggered(true, 1840, 1850, 1850.1), false)
})

// Sell ladder = averaging UP: trigger fires when ask rises to / above trigger_price.
test('isTriggered: sell fires when ask >= trigger', () => {
  assert.equal(isTriggered(false, 1860, 1859.9, 1860), true)  // exactly at trigger
  assert.equal(isTriggered(false, 1860, 1860, 1861), true)
})

test('isTriggered: sell does NOT fire when ask < trigger', () => {
  assert.equal(isTriggered(false, 1860, 1849, 1849.5), false)
})

test('isTriggered: rejects invalid inputs', () => {
  assert.equal(isTriggered(true, 0, 1840, 1841), false)
  assert.equal(isTriggered(true, NaN, 1840, 1841), false)
  assert.equal(isTriggered(true, 1840, NaN, 1841), false)
  assert.equal(isTriggered(false, 1840, 1841, NaN), false)
})

// Pip math sanity: a buy ladder anchored at 1850 with stepPriceOffset=1.0 and
// stepIdx=3 has trigger = 1847. Bid at 1847.0 ⇒ fire.
test('isTriggered: realistic XAUUSD buy ladder fires correctly', () => {
  const anchor = 1850
  const stepPriceOffset = 1.0 // 10 smart pips on XAUUSD @ 2-digit
  const trigger = anchor - 3 * stepPriceOffset
  assert.equal(trigger, 1847)
  assert.equal(isTriggered(true, trigger, 1846.95, 1847.05), true)
  assert.equal(isTriggered(true, trigger, 1847.05, 1847.15), false)
})

// XAUUSD: point=0.01, slippage 20 points ⇒ tolerance $0.20 around the rung.
test('fillWithinTriggerBand: buy fill at/near the rung is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.50, ask: 4109.70, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

test('fillWithinTriggerBand: buy fill BELOW the rung (better entry) is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4105.10, ask: 4105.30, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

// Regression for the "layer fired at the top of a rally" bug: trigger crossed
// on a dip, but by send time ask rallied $2 above the rung — must NOT fire.
test('fillWithinTriggerBand: buy fill far above the rung is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4111.60, ask: 4111.81, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no_longer_triggered')
})

test('fillWithinTriggerBand: buy still triggered on bid but ask outside slippage band is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.60, ask: 4110.40, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'fill_outside_trigger_band')
})

test('fillWithinTriggerBand: sell fill below the rung beyond slippage is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: false, triggerPrice: 4120, bid: 4118.90, ask: 4120.05, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'fill_outside_trigger_band')
})

test('fillWithinTriggerBand: sell fill at/above the rung is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: false, triggerPrice: 4120, bid: 4120.10, ask: 4120.30, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

test('fillWithinTriggerBand: without symbol point only re-checks the trigger', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.60, ask: 4112.00, slippagePoints: 20, point: null }),
    { ok: true },
  )
  assert.equal(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4111.00, ask: 4111.20, slippagePoints: 20, point: null }).ok,
    false,
  )
})

test('evaluateTpTouch: buy basket locks at nearest TP touch', () => {
  const out = evaluateTpTouch({
    direction: 'buy',
    tps: [4510, 4530, 4550],
    bid: 4510,
    ask: 4510.2,
  })
  assert.equal(out.touched, true)
  assert.equal(out.triggerPrice, 4510)
  assert.equal(out.triggerSide, 'bid')
})

test('evaluateTpTouch: sell basket locks at nearest TP touch', () => {
  const out = evaluateTpTouch({
    direction: 'sell',
    tps: [4500, 4480, 4460],
    bid: 4500.2,
    ask: 4500,
  })
  assert.equal(out.touched, true)
  assert.equal(out.triggerPrice, 4500)
  assert.equal(out.triggerSide, 'ask')
})

test('evaluateTpTouch: ignores invalid TP direction/noise', () => {
  const out = evaluateTpTouch({
    direction: 'unknown',
    tps: [4500, 0, Number.NaN],
    bid: 4600,
    ask: 4600.5,
  })
  assert.equal(out.touched, false)
  assert.equal(out.triggerPrice, null)
  assert.equal(out.triggerSide, null)
})

test('shouldLockBasketLayering: live TP touch locks (sell)', () => {
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [4089.8, 4087.1, 4074.5],
    openCount: 3,
    closedCount: 0,
    bid: 4090,
    ask: 4089.7,
  })
  assert.equal(out.lock, true)
  assert.equal(out.reason, 'tp_touched')
  assert.equal(out.triggerPrice, 4089.8)
})

test('shouldLockBasketLayering: partially closed basket locks even when quote is far from remaining TPs', () => {
  // TP1 trades closed at the broker; only deep-TP trades remain open and the
  // quote has reversed away — the open-only touch check can never fire.
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [4074.5],
    openCount: 5,
    closedCount: 16,
    bid: 4094.5,
    ask: 4094.8,
  })
  assert.equal(out.lock, true)
  assert.equal(out.reason, 'basket_partially_closed')
  assert.equal(out.triggerPrice, null)
})

test('shouldLockBasketLayering: fully open basket with no touch stays unlocked', () => {
  const out = shouldLockBasketLayering({
    direction: 'buy',
    openTps: [4120, 4140],
    openCount: 4,
    closedCount: 0,
    bid: 4095,
    ask: 4095.3,
  })
  assert.equal(out.lock, false)
  assert.equal(out.reason, null)
})

test('shouldLockBasketLayering: flat basket (no open trades) does not lock', () => {
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [],
    openCount: 0,
    closedCount: 12,
    bid: 4094.5,
    ask: 4094.8,
  })
  assert.equal(out.lock, false)
})
