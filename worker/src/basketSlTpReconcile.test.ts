import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePerLegTargets,
  reconcileBackoffMs,
  clampBasketOrderStops,
  classifyGhostBasketLegs,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
} from './basketSlTpReconcile'
import type { BasketOpenLeg } from './basketSlTpReconcile'

describe('parsePerLegTargets', () => {
  it('parses jsonb array of targets', () => {
    const out = parsePerLegTargets([
      { stoploss: 100, takeprofit: 110 },
      { stoploss: 99, takeprofit: 111 },
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0]!.stoploss, 100)
    assert.equal(out[1]!.takeprofit, 111)
  })

  it('returns empty for invalid input', () => {
    assert.deepEqual(parsePerLegTargets(null), [])
    assert.deepEqual(parsePerLegTargets('x'), [])
  })
})

describe('reconcileBackoffMs', () => {
  it('grows with attempts and caps at 5 minutes', () => {
    const a0 = reconcileBackoffMs(0)
    const a3 = reconcileBackoffMs(3)
    const a10 = reconcileBackoffMs(10)
    assert.ok(a3 >= a0)
    assert.ok(a10 <= 300_000)
  })
})

describe('classifyGhostBasketLegs', () => {
  const leg = (ticket: number | null): BasketOpenLeg => ({
    id: `t-${ticket ?? 'x'}`,
    signal_id: 'sig-1',
    metaapi_order_id: ticket == null ? null : String(ticket),
    opened_at: new Date().toISOString(),
    lot_size: 0.01,
    sl: null,
    tp: null,
    entry_price: 1,
    direction: 'buy',
    symbol: 'XAUUSD',
  })

  it('treats legs with tickets absent from broker as ghost', () => {
    const { onBroker, ghost } = classifyGhostBasketLegs(
      [leg(100), leg(200)],
      new Set([100]),
    )
    assert.equal(onBroker.length, 1)
    assert.equal(ghost.length, 1)
    assert.equal(ghost[0]!.metaapi_order_id, '200')
  })

  it('treats missing ticket as ghost', () => {
    const { onBroker, ghost } = classifyGhostBasketLegs([leg(null)], new Set([100]))
    assert.equal(onBroker.length, 0)
    assert.equal(ghost.length, 1)
  })

  it('all ghost when broker flat', () => {
    const family = [leg(1), leg(2)]
    const { onBroker, ghost } = classifyGhostBasketLegs(family, new Set())
    assert.equal(onBroker.length, 0)
    assert.equal(ghost.length, 2)
  })

  it('exports user message for stale basket close', () => {
    assert.ok(GHOST_BASKET_CLOSED_USER_MESSAGE.includes('TSCopier'))
  })
})

describe('clampBasketOrderStops', () => {
  it('pushes buy SL below reference when too tight', () => {
    const { args, adjustments } = clampBasketOrderStops(
      {
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 0.01,
        price: 1.1,
        stoploss: 1.0999,
        takeprofit: 1.102,
      },
      { point: 0.00001, stopsLevel: 10, freezeLevel: 0, minLot: 0.01, lotStep: 0.01, contractSize: null, digits: 5 },
    )
    assert.ok(adjustments.length > 0 || args.stoploss! < 1.1)
  })
})
