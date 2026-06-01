import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateTpTouch, isTriggered } from './virtualPendingMonitor'

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
