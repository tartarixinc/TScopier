import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadExactProviderCloseArtifacts,
  loadRangePendingLegsInMgmtScope,
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
      breakevenManualByBroker: new Map(),
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

  it('breakeven sets stoploss entry + offset pips', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const pendingLegs: RangePendingMgmtRow[] = [
      {
        id: 'leg-1',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 1,
        is_buy: true,
        anchor_price: 4330,
        stoploss: 4320,
        takeprofit: 4350,
        cwe_close_price: null,
        status: 'pending',
      },
    ]
    const mockSupabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            in: () => {
              updates.push({ id: 'leg-1', patch })
              return Promise.resolve({ error: null })
            },
          }),
        }),
      }),
    }
    const n = await updateRangePendingLegsForManagement({
      supabase: mockSupabase as never,
      parsed: {},
      pendingLegs,
      openTrades: [],
      tpLotsByBroker: new Map(),
      breakevenManualByBroker: new Map([['b1', { breakeven_offset_pips: 5 }]]),
      action: 'breakeven',
      hasNewSl: false,
      hasNewTp: false,
      parsedTpLevels: [],
    })
    assert.equal(n, 1)
    assert.equal(updates[0]!.patch.stoploss, 4330.5)
  })
})

describe('exact provider close null scope', () => {
  it('never queries when both basket and channel scope are null', async () => {
    let queried = false
    const rows = await loadRangePendingLegsInMgmtScope(
      { from() { queried = true; throw new Error('must not query') } } as never,
      {
        userId: 'u1',
        brokerAccountIds: ['b1'],
        channelId: null,
        basketSignalId: null,
      },
    )
    assert.deepEqual(rows, [])
    assert.equal(queried, false)
  })
})
describe('exact provider close durable artifacts', () => {
  it('queries strict pending and waits with parent P and returns only P scopes', async () => {
    const filters: Array<[string, string, unknown]> = []
    const supabase = {
      from(table: string) {
        const query = {
          select() { return query },
          eq(column: string, value: unknown) {
            filters.push([table, column, value])
            return query
          },
          in() { return query },
          limit() { return query },
          then(resolve: (value: unknown) => unknown) {
            const data = table === 'signal_entry_pending_orders'
              ? [{ broker_account_id: 'b1', symbol: 'XAUUSD' }]
              : [{ broker_account_id: 'b2', symbol: 'XAUUSD' }]
            return Promise.resolve({ data, error: null }).then(resolve)
          },
        }
        return query
      },
    }
    const result = await loadExactProviderCloseArtifacts(supabase as never, {
      parentSignalId: 'P',
      brokerAccountIds: ['b1', 'b2'],
    })
    assert.equal(result.error, null)
    assert.equal(result.entryPendingCount, 1)
    assert.equal(result.waitingCount, 1)
    assert.deepEqual(result.scopes.map(scope => scope.signalId), ['P'])
    assert.deepEqual(result.scopes.map(scope => scope.brokerAccountId), ['b1'])
    assert.deepEqual(result.waitScopes.map(scope => scope.signalId), ['P'])
    assert.deepEqual(result.waitScopes.map(scope => scope.brokerAccountId), ['b2'])
    assert.equal(filters.filter(call => call[1] === 'signal_id' && call[2] === 'P').length, 2)
  })
})