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
    assert.ok(GHOST_BASKET_CLOSED_USER_MESSAGE.includes('UniCopier'))
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
  it('keeps reconcile open when unfixable legs were skipped', () => {
    assert.equal(
      basketLegModifyMergeFailed({
        openLegs: 32,
        attempted: 30,
        modified: 30,
        failed: 0,
        skippedNoTicket: 0,
        skippedUnfixable: 2,
      }),
      true,
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

  it('completes when every leg modified with no skips or failures', () => {
    assert.equal(
      basketLegModifyMergeFailed({
        openLegs: 32,
        attempted: 32,
        modified: 32,
        failed: 0,
        skippedNoTicket: 0,
        skippedUnfixable: 0,
      }),
      false,
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
    assert.equal(basketLegModifyMergeFailed(summary), true)
    const skipped = inserts.find(
      (row) => (row as { status?: string }).status === 'skipped',
    ) as { request_payload?: { skip_reason?: string } } | undefined
    assert.equal(skipped?.request_payload?.skip_reason, 'wrong_side_sl')
  })
})

describe('runBasketLegModifies modify outcome observability counters', () => {
  const familyLeg = (ticket = 9001): BasketOpenLeg => ({
    id: `trade-${ticket}`,
    signal_id: 'sig-mod',
    metaapi_order_id: String(ticket),
    opened_at: new Date().toISOString(),
    lot_size: 0.05,
    sl: 4370,
    tp: 4400,
    entry_price: 4390,
    direction: 'buy',
    symbol: 'XAUUSD',
  })

  const supabase = () => ({
    from: () => ({
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  })

  async function runOne(
    api: { orderModify: (uuid: string, args: { ticket: number; stoploss?: number; takeprofit?: number }) => Promise<unknown> },
    opts?: { openedTickets?: Set<number> },
  ) {
    const leg = familyLeg()
    return runBasketLegModifies({
      supabase: supabase() as never,
      api: {
        quote: async () => ({ bid: 4390, ask: 4391, symbol: 'XAUUSD' }),
        ...api,
      } as never,
      uuid: 'broker-uuid',
      symbol: 'XAUUSD',
      direction: 'buy',
      baseLot: 0.05,
      params: { point: 0.01, stopsLevel: 0, freezeLevel: 0, minLot: 0.01, lotStep: 0.01, contractSize: null, digits: 2 },
      signalId: 'sig-mod',
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      familyTrades: [leg],
      perLegTargets: [{ stoploss: 4376, takeprofit: 4410 }],
      signalTps: [4410, 4420],
      nImmCwe: 0,
      overrideTp: null,
      strictEntryPrefetch: { bid: 4390, ask: 4391 },
      openedTickets: opts?.openedTickets ?? new Set([9001]),
      internalRebalance: true,
    })
  }

  it('treats already-applied/no-change modify replies as benign success', async () => {
    const { summary, legErrors } = await runOne({
      orderModify: async () => {
        throw new Error('No changes')
      },
    })

    assert.equal(summary.modified, 1)
    assert.equal(summary.failed, 0)
    assert.equal(summary.benignModify, 1)
    assert.equal(summary.positionGone, 0)
    assert.equal(legErrors.length, 0)
  })

  it('treats unknown-ticket/already-closed modify replies as benign position-gone outcomes', async () => {
    const { summary, legErrors } = await runOne({
      orderModify: async () => {
        throw new Error('OrderModify: unknown ticket')
      },
    })

    assert.equal(summary.modified, 1)
    assert.equal(summary.failed, 0)
    assert.equal(summary.benignModify, 1)
    assert.equal(summary.positionGone, 1)
    assert.equal(legErrors.length, 0)
  })

  it('keeps empty broker snapshots as skipped-not-on-broker rather than final failures', async () => {
    let modifyCalled = false
    const { summary, legErrors } = await runOne({
      orderModify: async () => {
        modifyCalled = true
        throw new Error('should not modify when snapshot is empty')
      },
    }, { openedTickets: new Set() })

    assert.equal(modifyCalled, false)
    assert.equal(summary.modified, 0)
    assert.equal(summary.failed, 0)
    assert.equal(summary.skippedNotOnBroker, 1)
    assert.equal(summary.positionGone, 1)
    assert.equal(legErrors[0]!.skip_reason, 'skipped_not_on_broker')
  })

  it('counts broker timeout during modify as a hard failed leg', async () => {
    const { summary, legErrors } = await runOne({
      orderModify: async () => {
        throw new Error('TradingHelper.OrderModify timed out')
      },
    })

    assert.equal(summary.modified, 0)
    assert.equal(summary.failed, 1)
    assert.equal(summary.benignModify, 0)
    assert.equal(summary.positionGone, 0)
    assert.match(legErrors[0]!.error, /timed out/)
  })

  it('keeps invalid-stops split fallback as success when SL/TP fallback lands', async () => {
    const calls: Array<{ stoploss?: number; takeprofit?: number }> = []
    const { summary, legErrors } = await runOne({
      orderModify: async (_uuid, args) => {
        calls.push(args)
        if (args.stoploss != null && args.takeprofit != null) throw new Error('Invalid stops')
        return { stopLoss: args.stoploss ?? null, takeProfit: args.takeprofit ?? null }
      },
    })

    assert.equal(summary.modified, 1)
    assert.equal(summary.failed, 0)
    assert.equal(legErrors.length, 0)
    assert.equal(calls.length, 3, 'combined + SL-only + TP-only')
  })

  it('does not treat MT4 4108 invalid request as benign for modify semantics', async () => {
    const { summary, legErrors } = await runOne({
      orderModify: async () => {
        throw new Error('MT4 error 4108: Invalid request')
      },
    })

    assert.equal(summary.modified, 0)
    assert.equal(summary.failed, 1)
    assert.equal(summary.benignModify, 0)
    assert.equal(summary.positionGone, 0)
    assert.match(legErrors[0]!.error, /4108/)
  })
})
