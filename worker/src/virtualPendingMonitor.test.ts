import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isTriggered } from './virtualPendingMonitor'

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
