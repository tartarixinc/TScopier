import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filledFlagForOpenedOrder } from './tradeBrokerDriftMonitor'

/**
 * The fill flag decides whether a `pending` trade row is promoted
 * pending→open (and announced as a fill) and how a revived row is labelled.
 * Getting it wrong in the permissive direction turns a live resting order
 * into a false "entry filled" notification and corrupts the trade state.
 */
describe('filledFlagForOpenedOrder', () => {
  it('treats numeric MT4 pending kinds (2–5) as resting, not filled', () => {
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 2 }), false) // BuyLimit
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 3 }), false) // SellLimit
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 4 }), false) // BuyStop
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 5 }), false) // SellStop
  })

  it('treats string pendings as resting, not filled', () => {
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, operation: 'buy limit' }), false)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, Operation: 'Sell Stop' }), false)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, orderType: 'SellStop' }), false)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, state: 'PLACED' }), false)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, pending: true }), false)
  })

  it('treats live position shapes as filled', () => {
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, state: 'OPEN_NORMAL' }), true)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, state: 'filled' }), true)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, operation: 'Buy' }), true)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 0 }), true)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, type: 1 }), true)
    assert.equal(filledFlagForOpenedOrder({ ticket: 1, orderType: 'DealBuy' }), true)
  })

  it('never reports an unrecognised row as filled (no promote without evidence)', () => {
    assert.equal(filledFlagForOpenedOrder({ ticket: 1 }), false)
    assert.equal(filledFlagForOpenedOrder({}), false)
  })
})
