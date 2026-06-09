import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pendingLegsToCancelScopes,
  updateRangePendingLegsForManagement,
} from './managementPendingLegs'
import type { RangePendingMgmtRow } from './managementPendingLegs'

describe('pendingLegsToCancelScopes', () => {
  it('dedupes by signal broker symbol', () => {
    const legs: RangePendingMgmtRow[] = [
      {
        id: '1',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 0,
        is_buy: true,
        anchor_price: 4500,
        stoploss: 4470,
        takeprofit: 4600,
        cwe_close_price: null,
        status: 'pending',
      },
      {
        id: '2',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 1,
        is_buy: true,
        anchor_price: 4490,
        stoploss: 4470,
        takeprofit: 4600,
        cwe_close_price: null,
        status: 'pending',
      },
    ]
    const scopes = pendingLegsToCancelScopes(legs)
    assert.equal(scopes.length, 1)
    assert.equal(scopes[0]!.signalId, 'sig-a')
  })
})

describe('updateRangePendingLegsForManagement', () => {
  it('modify with new SL updates all active pending legs', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const pendingLegs: RangePendingMgmtRow[] = [
      {
        id: 'leg-1',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 1,
        is_buy: false,
        anchor_price: 4309,
        stoploss: 4315,
        takeprofit: 4306,
        cwe_close_price: null,
        status: 'pending',
      },
      {
        id: 'leg-2',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 2,
        is_buy: false,
        anchor_price: 4307,
        stoploss: 4315,
        takeprofit: 4304,
        cwe_close_price: null,
        status: 'pending',
      },
    ]
    const mockSupabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, id: string) => ({
            in: () => {
              updates.push({ id, patch })
              return Promise.resolve({ error: null })
            },
          }),
        }),
      }),
    }
    const n = await updateRangePendingLegsForManagement({
      supabase: mockSupabase as never,
      parsed: { sl: 4303, tp: [4301, 4299] },
      pendingLegs,
      openTrades: [],
      tpLotsByBroker: new Map(),
      action: 'modify',
      hasNewSl: true,
      hasNewTp: false,
      parsedTpLevels: [],
    })
    assert.equal(n, 2)
    assert.equal(updates.length, 2)
    for (const u of updates) {
      assert.equal(u.patch.stoploss, 4303)
    }
  })
})
