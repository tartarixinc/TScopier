import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureBrokerPositionIdentity } from './captureBrokerPositionIdentity'

function fakeSupabase(writes: Array<Record<string, unknown>>) {
  const client = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          is: async () => {
            writes.push(patch)
            return { error: null }
          },
        }),
      }),
    }),
  }
  return client as unknown as SupabaseClient
}

const trade = {
  id: 'trade-1',
  metaapi_order_id: '5001',
  symbol: 'XAUUSD',
  direction: 'buy',
  lot_size: 0.05,
  entry_price: 4146.6,
}

describe('captureBrokerPositionIdentity', () => {
  it('writes the resolved position ticket', async () => {
    const writes: Array<Record<string, unknown>> = []
    const ticket = await captureBrokerPositionIdentity({
      supabase: fakeSupabase(writes),
      tradeRowId: 'trade-1',
      trade,
      openedOrders: [{ ticket: 6002, orderTicket: 5001, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.6 }],
    })
    assert.equal(ticket, 6002)
    assert.deepEqual(writes, [{ broker_position_ticket: '6002' }])
  })

  it('never writes a guess when the read is ambiguous', async () => {
    const writes: Array<Record<string, unknown>> = []
    const ticket = await captureBrokerPositionIdentity({
      supabase: fakeSupabase(writes),
      tradeRowId: 'trade-1',
      trade: { ...trade, metaapi_order_id: '999999' },
      openedOrders: [
        { ticket: 6001, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.6 },
        { ticket: 6002, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.6 },
      ],
    })
    assert.equal(ticket, null)
    assert.equal(writes.length, 0)
  })

  it('does nothing when the broker read failed', async () => {
    const writes: Array<Record<string, unknown>> = []
    const ticket = await captureBrokerPositionIdentity({
      supabase: fakeSupabase(writes),
      tradeRowId: 'trade-1',
      trade,
      openedOrders: null,
    })
    assert.equal(ticket, null)
    assert.equal(writes.length, 0)
  })
})

describe('captureBrokerPositionIdentity — attribute-only matches', () => {
  function fakeSupabase2(writes: Array<Record<string, unknown>>) {
    return {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({ is: async () => { writes.push(patch); return { error: null } } }),
        }),
      }),
    } as unknown as SupabaseClient
  }

  it('does not write when the only match is by attributes (never a guess)', async () => {
    const writes: Array<Record<string, unknown>> = []
    const ticket = await captureBrokerPositionIdentity({
      supabase: fakeSupabase2(writes),
      tradeRowId: 'trade-1',
      trade: { id: 'trade-1', metaapi_order_id: '999999', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.05, entry_price: 4146.6 },
      openedOrders: [
        { ticket: 6001, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.6 },
      ],
    })
    assert.equal(ticket, null)
    assert.equal(writes.length, 0)
  })
})
