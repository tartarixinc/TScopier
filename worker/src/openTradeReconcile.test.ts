import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findGhostOpenTradeIds, reconcileOpenTradesForBroker } from './openTradeReconcile'

describe('findGhostOpenTradeIds', () => {
  it('returns ids for tickets absent from broker', () => {
    const ghost = findGhostOpenTradeIds(
      [
        { id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' },
        { id: 'b', broker_account_id: 'b1', metaapi_order_id: '200' },
      ],
      new Set([200]),
    )
    assert.deepEqual(ghost, ['a'])
  })

  it('ignores rows without a valid ticket', () => {
    const ghost = findGhostOpenTradeIds(
      [
        { id: 'a', broker_account_id: 'b1', metaapi_order_id: null },
        { id: 'b', broker_account_id: 'b1', metaapi_order_id: '0' },
      ],
      new Set(),
    )
    assert.deepEqual(ghost, [])
  })

  it('returns empty when all tickets are on broker', () => {
    const ghost = findGhostOpenTradeIds(
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' }],
      new Set([100]),
    )
    assert.deepEqual(ghost, [])
  })
})

describe('reconcileOpenTradesForBroker', () => {
  it('does not mass-close when OpenedOrders is empty', async () => {
    const updates: unknown[] = []
    const supabase = {
      from(table: string) {
        assert.equal(table, 'trades')
        return {
          select() {
            return this
          },
          in() {
            return this
          },
          eq() {
            return this
          },
          update(payload: unknown) {
            updates.push(payload)
            return {
              in: () => ({
                eq: () => ({
                  select: async () => ({ data: [], error: null }),
                }),
              }),
            }
          },
        }
      },
    }
    const api = {
      openedOrders: async () => [],
    }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' }],
    )
    assert.equal(closed, 0)
    assert.equal(updates.length, 0)
  })


  it('does not falsely close after one non-empty identity-mismatch snapshot', async () => {
    let openedCalls = 0
    const api = {
      openedOrders: async () => {
        openedCalls += 1
        if (openedCalls === 1) return [{ ticket: 999, type: 0, symbol: 'GBPUSD' }]
        return [{ ticket: 100, type: 0, symbol: 'EURUSD', lots: 0.1, openPrice: 1.1 }]
      },
    }
    const supabase = {
      from() {
        throw new Error('DB must not be mutated when the second snapshot restores identity')
      },
    }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{
        id: 'a',
        broker_account_id: 'b1',
        metaapi_order_id: '100',
        symbol: 'EURUSD',
        direction: 'buy',
        lot_size: 0.1,
        entry_price: 1.1,
      }],
    )
    assert.equal(closed, 0)
    assert.equal(openedCalls, 2)
  })
})
