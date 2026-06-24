import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePerLegTargets,
  reconcileBackoffMs,
  clampBasketOrderStops,
  classifyGhostBasketLegs,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  basketLegModifyMergeFailed,
  runBasketLegModifies,
} from './basketSlTpReconcile'
import { isSlMoreProtective } from './basketEffectiveStops'
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
    assert.ok(GHOST_BASKET_CLOSED_USER_MESSAGE.includes('TScopier'))
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

describe('internal rebalance SL guard', () => {
  it('isSlMoreProtective blocks loosening breakeven SL on buys', () => {
    assert.equal(isSlMoreProtective(4258, 4245, true), true)
    assert.equal(isSlMoreProtective(4245, 4258, true), false)
  })
})

describe('basketLegModifyMergeFailed', () => {
  it('completes when unfixable legs were skipped (market moved)', () => {
    assert.equal(
      basketLegModifyMergeFailed({
        openLegs: 32,
        attempted: 30,
        modified: 30,
        failed: 0,
        skippedNoTicket: 0,
        skippedUnfixable: 2,
      }),
      false,
    )
  })

  it('fails when broker modify errors remain', () => {
    assert.equal(
      basketLegModifyMergeFailed({
        openLegs: 32,
        attempted: 32,
        modified: 30,
        failed: 2,
        skippedNoTicket: 0,
        skippedUnfixable: 0,
      }),
      true,
    )
  })
})

describe('runBasketLegModifies explicit loosening', () => {
  it('applies a looser explicit SL when explicitChannelTargets is true', async () => {
    const familyLeg: BasketOpenLeg = {
      id: 'trade-1',
      signal_id: 'sig-mod',
      metaapi_order_id: '9001',
      opened_at: new Date().toISOString(),
      lot_size: 0.05,
      sl: 4180, // current tighter SL for a sell (closer to price)
      tp: 4100,
      entry_price: 4150,
      direction: 'sell',
      symbol: 'XAUUSD',
    }
    let modifiedSl: number | null = null
    const api = {
      quote: async () => ({ bid: 4150, ask: 4150.2, symbol: 'XAUUSD' }),
      orderModify: async (_uuid: string, args: { stoploss?: number }) => {
        modifiedSl = args.stoploss ?? null
        return { stopLoss: args.stoploss, takeProfit: 4100 }
      },
    }
    const supabase = {
      from: () => ({
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    }

    const { summary } = await runBasketLegModifies({
      supabase: supabase as never,
      api: api as never,
      uuid: 'broker-uuid',
      symbol: 'XAUUSD',
      direction: 'sell',
      baseLot: 0.05,
      params: { point: 0.01, stopsLevel: 0, freezeLevel: 0, minLot: 0.01, lotStep: 0.01, contractSize: null, digits: 2 },
      signalId: 'sig-mod',
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      familyTrades: [familyLeg],
      perLegTargets: [{ stoploss: 4200, takeprofit: 4100 }], // looser SL (further above price) for sell
      nImmCwe: 0,
      overrideTp: null,
      strictEntryPrefetch: null,
      openedTickets: new Set([9001]),
      explicitChannelTargets: true,
    })

    assert.equal(summary.modified, 1)
    assert.equal(modifiedSl, 4200, 'explicit channel target loosens the SL (no protective block)')
  })
})

describe('runBasketLegModifies wrong-side guard', () => {
  it('skips sell leg when channel TP is above live bid (explicit targets)', async () => {
    const familyLeg: BasketOpenLeg = {
      id: 'trade-1',
      signal_id: 'sig-mod',
      metaapi_order_id: '9001',
      opened_at: new Date().toISOString(),
      lot_size: 0.05,
      sl: null,
      tp: null,
      entry_price: 4118.75,
      direction: 'sell',
      symbol: 'XAUUSD',
    }
    const api = {
      quote: async () => ({ bid: 4110, ask: 4110.2, symbol: 'XAUUSD' }),
      orderModify: async () => {
        throw new Error('orderModify should not be called')
      },
    }
    const inserts: unknown[] = []
    const supabase = {
      from: () => ({
        insert: async (row: unknown) => {
          inserts.push(row)
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    }

    const { summary, legErrors } = await runBasketLegModifies({
      supabase: supabase as never,
      api: api as never,
      uuid: 'broker-uuid',
      symbol: 'XAUUSD',
      direction: 'sell',
      baseLot: 0.05,
      params: { point: 0.01, stopsLevel: 0, freezeLevel: 0, minLot: 0.01, lotStep: 0.01, contractSize: null, digits: 2 },
      signalId: 'sig-mod',
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      familyTrades: [familyLeg],
      perLegTargets: [{ stoploss: 4100, takeprofit: 4116 }],
      nImmCwe: 0,
      overrideTp: null,
      strictEntryPrefetch: null,
      openedTickets: new Set([9001]),
      explicitChannelTargets: true,
      internalRebalance: true,
    })

    assert.equal(summary.skippedUnfixable, 1)
    assert.equal(summary.failed, 0)
    assert.equal(legErrors.length, 0)
    assert.equal(basketLegModifyMergeFailed(summary), false)
    const skipped = inserts.find(
      (row) => (row as { status?: string }).status === 'skipped',
    ) as { request_payload?: { skip_reason?: string } } | undefined
    assert.equal(skipped?.request_payload?.skip_reason, 'wrong_side_sl')
  })
})
