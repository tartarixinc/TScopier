import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { basketLegsOutOfSync } from './basketReconcileTargets'
import type { BasketOpenLeg } from './basketSlTpReconcile'

function leg(tp: number, sl = 4321): BasketOpenLeg {
  return {
    id: `leg-${tp}`,
    signal_id: 'sig-1',
    metaapi_order_id: '100',
    opened_at: '2026-06-17T11:08:00Z',
    lot_size: 0.01,
    sl,
    tp,
    entry_price: 4325,
    direction: 'buy',
    symbol: 'XAUUSD',
  }
}

describe('basketLegsOutOfSync', () => {
  it('detects when all legs share TP1 but targets distribute across ladder', () => {
    const family = [leg(4332), leg(4332), leg(4332)]
    const targets = [
      { stoploss: 4321, takeprofit: 4332 },
      { stoploss: 4321, takeprofit: 4334 },
      { stoploss: 4321, takeprofit: 4336 },
    ]
    assert.equal(basketLegsOutOfSync(family, targets, 0), true)
  })

  it('returns false when legs match distributed targets', () => {
    const family = [leg(4332), leg(4334), leg(4336)]
    const targets = [
      { stoploss: 4321, takeprofit: 4332 },
      { stoploss: 4321, takeprofit: 4334 },
      { stoploss: 4321, takeprofit: 4336 },
    ]
    assert.equal(basketLegsOutOfSync(family, targets, 0), false)
  })

  it('does not flag SL drift when legs hold effective adjusted SL but targets still carry anchor SL', () => {
    const family = [leg(4265, 4242), leg(4275, 4242)]
    const targets = [
      { stoploss: 4245, takeprofit: 4265 },
      { stoploss: 4245, takeprofit: 4275 },
    ]
    assert.equal(basketLegsOutOfSync(family, targets, 0, { effectiveStoploss: 4242 }), false)
  })

  it('detects missing SL on open legs', () => {
    const family = [{ ...leg(4332), sl: null }, leg(4334)]
    const targets = [
      { stoploss: 4321, takeprofit: 4332 },
      { stoploss: 4321, takeprofit: 4334 },
    ]
    assert.equal(basketLegsOutOfSync(family, targets, 0), true)
  })

  it('ignores TP drift when tpFrozen but still detects SL drift', () => {
    const family = [leg(4332, 4242), leg(4334, 4242)]
    const targets = [
      { stoploss: 4245, takeprofit: 9999 },
      { stoploss: 4245, takeprofit: 8888 },
    ]
    assert.equal(basketLegsOutOfSync(family, targets, 0, { tpFrozen: true }), true)
    const alignedSl = [
      { stoploss: 4242, takeprofit: 9999 },
      { stoploss: 4242, takeprofit: 8888 },
    ]
    assert.equal(basketLegsOutOfSync(family, alignedSl, 0, { tpFrozen: true }), false)
  })
})
