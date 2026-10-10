import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { basketLegsOutOfSync, basketLegsOutOfSyncOnBroker, sortSweepBasketsByChannelParamFreshness } from './basketReconcileTargets'
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

  it('ignores a stop on the wrong side of the leg entry (structurally un-applicable)', () => {
    // SELL filled at 82650 with a signal stop of 65000 — below the entry, which
    // no broker can set. Only the take-profit should be compared.
    const sell: BasketOpenLeg = {
      ...leg(62500, 0),
      entry_price: 82650,
      direction: 'sell',
      sl: 0,
    }
    const targets = [{ stoploss: 65000, takeprofit: 62500 }]
    assert.equal(basketLegsOutOfSync([sell], targets, 0), false)
    // ...but TP drift is still detected.
    assert.equal(basketLegsOutOfSync([sell], [{ stoploss: 65000, takeprofit: 60500 }], 0), true)
  })

  it('ignores a target on the wrong side of the leg entry too', () => {
    // Buy-side values applied to a sell: stop below entry, target above entry —
    // both are structurally un-applicable, so neither is reported as drift.
    const sell: BasketOpenLeg = { ...leg(79000, 0), entry_price: 82650, direction: 'sell', sl: 0 }
    assert.equal(basketLegsOutOfSync([sell], [{ stoploss: 65000, takeprofit: 83300 }], 0), false)
  })

  it('does not demand a target dropped as un-applicable (requireTakeProfit)', () => {
    const sell: BasketOpenLeg = { ...leg(79000, 0), entry_price: 82650, direction: 'sell', sl: 0 }
    assert.equal(
      basketLegsOutOfSync([sell], [{ stoploss: 65000, takeprofit: 83300 }], 0, { requireTakeProfit: true }),
      false,
    )
  })
})

describe('basketLegsOutOfSyncOnBroker', () => {
  it('detects broker SL drift when DB matches target', () => {
    const family = [leg(4332, 4104)]
    const targets = [{ stoploss: 4104, takeprofit: 4332 }]
    assert.equal(basketLegsOutOfSync(family, targets, 0), false)
    const orders = new Map<number, unknown>([[100, { stopLoss: 4100 }]])
    assert.equal(basketLegsOutOfSyncOnBroker(family, targets, orders, 0), true)
  })

  it('returns false when broker SL matches target', () => {
    const family = [leg(4332, 4104)]
    const targets = [{ stoploss: 4104, takeprofit: 4332 }]
    const orders = new Map<number, unknown>([[100, { stopLoss: 4104 }]])
    assert.equal(basketLegsOutOfSyncOnBroker(family, targets, orders, 0), false)
  })

  it('still detects SL drift when the target take-profit is on the wrong side', () => {
    // Valid SL target (above a sell entry) but a wrong-side TP must not skip the check.
    const sell: BasketOpenLeg = { ...leg(79000, 83000), entry_price: 82650, direction: 'sell' }
    const targets = [{ stoploss: 83000, takeprofit: 83300 }]
    const orders = new Map<number, unknown>([[100, { stopLoss: 81000 }]])
    assert.equal(basketLegsOutOfSyncOnBroker([sell], targets, orders, 0), true)
  })
})

describe('sortSweepBasketsByChannelParamFreshness', () => {
  it('prioritizes baskets with newer channel params than leg rows', () => {
    const rows = [
      {
        broker_account_id: 'b1',
        signal_id: 's1',
        symbol: 'XAUUSD',
        direction: 'sell',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'b2',
        signal_id: 's2',
        symbol: 'EURUSD',
        direction: 'buy',
        telegram_channel_id: 'ch-2',
      },
    ]
    const channelParamUpdatedAt = new Map([
      ['ch-1|XAUUSD', '2026-06-20T12:00:00Z'],
      ['ch-2|EURUSD', '2026-06-19T10:00:00Z'],
    ])
    const legUpdatedAtByKey = new Map([
      ['b1|s1', '2026-06-20T11:00:00Z'],
      ['b2|s2', '2026-06-20T11:00:00Z'],
    ])
    const sorted = sortSweepBasketsByChannelParamFreshness(
      rows,
      channelParamUpdatedAt,
      legUpdatedAtByKey,
    )
    assert.equal(sorted[0]?.broker_account_id, 'b1')
  })
})
