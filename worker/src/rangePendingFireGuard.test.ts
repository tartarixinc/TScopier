import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  basketInProfitAtQuote,
  hasTpTouchedLock,
  loadExistingRangeStepIndices,
  shouldBlockVirtualLegFire,
} from './rangePendingFireGuard'

describe('loadExistingRangeStepIndices', () => {
  it('returns step indices from select rows', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({
                  data: [{ step_idx: 0 }, { step_idx: 3 }, { step_idx: 3 }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }
    const steps = await loadExistingRangeStepIndices(
      supabase as never,
      'sig-1',
      'broker-1',
      'XAUUSD',
    )
    assert.deepEqual([...steps].sort((a, b) => a - b), [0, 3])
  })
})

describe('hasTpTouchedLock', () => {
  it('returns true when lock row exists', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: async () => ({
                count: 1,
                error: null,
              }),
            }),
          }),
        }),
      }),
    }
    const out = await hasTpTouchedLock(
      supabase as never,
      { signalId: 'sig-1', brokerAccountId: 'broker-1', symbol: 'XAUUSD' },
    )
    assert.equal(out, true)
  })
})

describe('basketInProfitAtQuote', () => {
  it('returns false for empty basket', () => {
    assert.equal(basketInProfitAtQuote([], false, 4173, 4173.2), false)
  })

  it('sell basket in profit when ask is at or below volume-weighted average entry', () => {
    const trades = [
      { entry_price: 4173.35, lot_size: 0.06 },
      { entry_price: 4173.35, lot_size: 0.06 },
    ]
    assert.equal(basketInProfitAtQuote(trades, false, 4172.5, 4173.35), true)
    assert.equal(basketInProfitAtQuote(trades, false, 4172.5, 4173.20), true)
    assert.equal(basketInProfitAtQuote(trades, false, 4172.5, 4173.50), false)
  })

  it('buy basket in profit when bid is at or above volume-weighted average entry', () => {
    const trades = [{ entry_price: 100, lot_size: 0.1 }]
    assert.equal(basketInProfitAtQuote(trades, true, 100, 100.2), true)
    assert.equal(basketInProfitAtQuote(trades, true, 99.5, 100.2), false)
  })

  it('uses volume-weighted average entry', () => {
    const trades = [
      { entry_price: 100, lot_size: 1.0 },
      { entry_price: 110, lot_size: 0.1 },
    ]
    // avg = (100 + 11) / 1.1 ≈ 100.91
    assert.equal(basketInProfitAtQuote(trades, false, 100, 100.90), true)
    assert.equal(basketInProfitAtQuote(trades, false, 100, 101.0), false)
  })
})

describe('shouldBlockVirtualLegFire', () => {
  it('blocks with basket_in_profit without mutating the leg row', async () => {
    let legUpdateCalled = false
    const supabase = {
      from: (table: string) => {
        if (table === 'range_pending_tp_locks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({ count: 0, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'range_pending_legs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: async () => ({ count: 0, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: () => {
              legUpdateCalled = true
              return {
                eq: () => ({
                  in: () => ({
                    select: () => ({
                      maybeSingle: async () => ({ data: null, error: null }),
                    }),
                  }),
                }),
              }
            },
          }
        }
        if (table === 'trade_execution_logs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      order: () => ({
                        limit: () => ({
                          maybeSingle: async () => ({ data: null, error: null }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'trades') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({
                    data: [{ entry_price: 4173.35, lot_size: 0.15 }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        return {}
      },
    }
    const out = await shouldBlockVirtualLegFire(
      supabase as never,
      {
        id: 'leg-1',
        signal_id: 'sig-1',
        broker_account_id: 'broker-1',
        symbol: 'XAUUSD',
        step_idx: 2,
      },
      {
        quote: { bid: 4172.5, ask: 4173.20 },
        isBuy: false,
      },
    )
    assert.equal(out.block, true)
    assert.equal(out.reason, 'basket_in_profit')
    assert.equal(legUpdateCalled, false)
  })

  it('ignores tp lock when layerTillClose is enabled', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'range_pending_tp_locks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({ count: 1, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'range_pending_legs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: async () => ({ count: 0, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'trade_execution_logs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      order: () => ({
                        limit: () => ({
                          maybeSingle: async () => ({ data: null, error: null }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }
        }
        return {}
      },
    }
    const out = await shouldBlockVirtualLegFire(
      supabase as never,
      {
        id: 'leg-1',
        signal_id: 'sig-1',
        broker_account_id: 'broker-1',
        symbol: 'XAUUSD',
        step_idx: 2,
      },
      { layerTillClose: true },
    )
    assert.equal(out.block, false)
  })
})
