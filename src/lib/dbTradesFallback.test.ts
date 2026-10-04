import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BROKER_ACCOUNT_CLIENT_SELECT } from './brokerAccountSelect'
import {
  DB_TRADES_FALLBACK_LIMIT,
  DB_TRADES_FALLBACK_SELECT,
  fetchTradesFromDatabase,
  mapDbTradesToMtTrades,
  recoverFromLiveFeedFailure,
} from './dbTradesFallback'
import type { MtTrade } from './fxsocketBroker'
import type { BrokerAccount, Trade } from '../types/database'

function row(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    user_id: 'u1',
    signal_id: null,
    broker_account_id: 'b1',
    metaapi_order_id: '9001',
    symbol: 'XAUUSD',
    direction: 'buy',
    entry_price: 2500,
    sl: 2490,
    tp: 2520,
    lot_size: 0.1,
    status: 'closed',
    opened_at: '2026-06-10T10:00:00.000Z',
    closed_at: '2026-06-10T12:00:00.000Z',
    profit: 100,
    close_price: 2510,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function account(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    id: 'b1',
    user_id: 'u1',
    label: 'Main account',
    broker_name: 'Example Brokers',
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as BrokerAccount
}

describe('mapDbTradesToMtTrades', () => {
  it('maps a closed stored trade and resolves the account label', () => {
    const [mt] = mapDbTradesToMtTrades([row()], [account()])

    assert.equal(mt.id, 't1')
    assert.equal(mt.broker_id, 'b1')
    assert.equal(mt.broker_label, 'Main account')
    assert.equal(mt.broker_name, 'Example Brokers')
    assert.equal(mt.ticket, 9001)
    assert.equal(mt.symbol, 'XAUUSD')
    assert.equal(mt.direction, 'buy')
    assert.equal(mt.type, 'Buy')
    assert.equal(mt.lot_size, 0.1)
    assert.equal(mt.entry_price, 2500)
    assert.equal(mt.sl, 2490)
    assert.equal(mt.tp, 2520)
    assert.equal(mt.close_price, 2510)
    assert.equal(mt.profit, 100)
    assert.equal(mt.opened_at, '2026-06-10T10:00:00.000Z')
    assert.equal(mt.closed_at, '2026-06-10T12:00:00.000Z')
    assert.equal(mt.status, 'closed')

    // Columns the stored table does not keep stay empty, as for a live row
    // that simply has no value for them.
    assert.equal(mt.swap, null)
    assert.equal(mt.commission, null)
    assert.equal(mt.comment, null)
    assert.equal(mt.magic, null)
    assert.equal(mt.state, null)
  })

  it('maps an open stored trade with sell direction', () => {
    const [mt] = mapDbTradesToMtTrades(
      [
        row({
          id: 't2',
          direction: 'sell',
          status: 'open',
          closed_at: null,
          close_price: null,
          profit: null,
          tp: null,
        }),
      ],
      [account()],
    )

    assert.equal(mt.direction, 'sell')
    assert.equal(mt.type, 'Sell')
    assert.equal(mt.status, 'open')
    assert.equal(mt.closed_at, null)
    assert.equal(mt.close_price, null)
    assert.equal(mt.profit, null)
    assert.equal(mt.tp, null)
  })

  it('normalizes unexpected direction and treats only terminal statuses as closed', () => {
    const [unknownDirection] = mapDbTradesToMtTrades(
      [row({ direction: 'long', status: 'open' })],
      [account()],
    )
    assert.equal(unknownDirection.direction, '')
    assert.equal(unknownDirection.type, '')
    assert.equal(unknownDirection.status, 'open')

    // Resting limit/stop orders sit in `pending` — they must display as open
    // (the app reads this table with status in ('open','pending')), never as
    // closed trades without a close price.
    const [pending] = mapDbTradesToMtTrades([row({ status: 'pending' })], [account()])
    assert.equal(pending.status, 'open')

    const [cancelled] = mapDbTradesToMtTrades([row({ status: 'cancelled' })], [account()])
    assert.equal(cancelled.status, 'closed')

    const [unknownStatus] = mapDbTradesToMtTrades([row({ status: 'weird' })], [account()])
    assert.equal(unknownStatus.status, 'open')
  })

  it('falls back to ticket 0 and empty account fields when identifiers are missing', () => {
    const [mt] = mapDbTradesToMtTrades(
      [row({ metaapi_order_id: null, broker_account_id: null })],
      [account()],
    )
    assert.equal(mt.ticket, 0)
    assert.equal(mt.broker_id, '')
    assert.equal(mt.broker_label, '')
    assert.equal(mt.broker_name, null)

    const [orphan] = mapDbTradesToMtTrades([row()], [account({ id: 'other' })])
    assert.equal(orphan.broker_label, '')
    assert.equal(orphan.broker_name, null)
  })
})

type FakeResult = { data: unknown[] | null; error: { message: string } | null }

type QueryLog = {
  table: string
  select: string
  eq: [string, unknown] | null
  order: string | null
  limit: number | null
  abortSignal: AbortSignal | null
}

function makeClient(accountsResult: FakeResult, tradesResult: FakeResult) {
  const queries: QueryLog[] = []
  const client = {
    from(table: string) {
      const log: QueryLog = {
        table,
        select: '',
        eq: null,
        order: null,
        limit: null,
        abortSignal: null,
      }
      queries.push(log)
      const result = table === 'trades' ? tradesResult : accountsResult
      const builder = {
        select(cols: string) {
          log.select = cols
          return builder
        },
        eq(col: string, value: unknown) {
          log.eq = [col, value]
          return builder
        },
        order(col: string) {
          log.order = col
          return builder
        },
        limit(count: number) {
          log.limit = count
          return builder
        },
        abortSignal(signal: AbortSignal) {
          log.abortSignal = signal
          return builder
        },
        then(
          onFulfilled?: (value: FakeResult) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(result).then(onFulfilled, onRejected)
        },
      }
      return builder
    },
  } as unknown as SupabaseClient

  return { client, queries }
}

describe('fetchTradesFromDatabase', () => {
  it('selects the needed columns, newest first, bounded, and since-connect filtered', async () => {
    const { client, queries } = makeClient(
      { data: [account()], error: null },
      {
        data: [
          row({ id: 'new', opened_at: '2026-06-10T10:00:00.000Z' }),
          row({ id: 'old', opened_at: '2026-05-01T10:00:00.000Z' }),
        ],
        error: null,
      },
    )

    const trades = await fetchTradesFromDatabase(client, 'u1')

    assert.deepEqual(
      trades.map(t => t.id),
      ['new'],
      'rows opened before the connect anchor must be dropped, as on the live path',
    )

    assert.equal(queries[0].table, 'broker_accounts')
    assert.equal(queries[0].select, BROKER_ACCOUNT_CLIENT_SELECT)
    assert.deepEqual(queries[0].eq, ['user_id', 'u1'])

    assert.equal(queries[1].table, 'trades')
    assert.equal(queries[1].select, DB_TRADES_FALLBACK_SELECT)
    assert.ok(queries[1].select.includes('close_price'))
    assert.ok(queries[1].select.includes('profit'))
    assert.ok(queries[1].select.includes('metaapi_order_id'))
    assert.ok(!queries[1].select.includes('*'), 'explicit columns only — no payload surprises')
    assert.deepEqual(queries[1].eq, ['user_id', 'u1'])
    assert.equal(queries[1].order, 'opened_at')
    assert.equal(queries[1].limit, DB_TRADES_FALLBACK_LIMIT)
    assert.ok(
      queries[0].abortSignal instanceof AbortSignal && queries[1].abortSignal instanceof AbortSignal,
      'both reads must carry a timeout so a hung request cannot stall the refresh loop',
    )
    assert.equal(queries[0].abortSignal, queries[1].abortSignal)
  })

  it('throws when the accounts query fails', async () => {
    const { client } = makeClient(
      { data: null, error: new Error('accounts down') },
      { data: [], error: null },
    )
    await assert.rejects(() => fetchTradesFromDatabase(client, 'u1'), /accounts down/)
  })

  it('throws when the trades query fails so the caller can show the live error', async () => {
    const { client } = makeClient(
      { data: [account()], error: null },
      { data: null, error: new Error('trades down') },
    )
    await assert.rejects(() => fetchTradesFromDatabase(client, 'u1'), /trades down/)
  })
})

describe('recoverFromLiveFeedFailure', () => {
  type Events = string[]
  function harness(overrides: Partial<Parameters<typeof recoverFromLiveFeedFailure>[0]> = {}) {
    const events: Events = []
    const rows = [{} as MtTrade]
    const recovery = {
      reason: 'live feed down',
      hasLiveRows: false,
      readStoredTrades: async () => rows,
      keepLiveRows: () => void events.push('keep'),
      applyStoredTrades: (stored: MtTrade[]) =>
        void events.push(stored === rows ? 'apply' : 'apply-other'),
      showReadError: (reason: string) => void events.push(`error:${reason}`),
      ...overrides,
    }
    return { events, recovery }
  }

  it('keeps live rows when live rows are already on screen', async () => {
    const { events, recovery } = harness({ hasLiveRows: true })
    await recoverFromLiveFeedFailure(recovery)
    assert.deepEqual(events, ['keep'])
  })

  it('applies stored rows when no live rows are on screen', async () => {
    const { events, recovery } = harness()
    await recoverFromLiveFeedFailure(recovery)
    assert.deepEqual(events, ['apply'])
  })

  it('retries stored rows on every failure while live rows are absent', async () => {
    const { events, recovery } = harness()
    await recoverFromLiveFeedFailure(recovery)
    await recoverFromLiveFeedFailure(recovery)
    assert.deepEqual(events, ['apply', 'apply'], 'a prolonged outage keeps refreshing stored rows')
  })

  it('shows the live error only when the stored read also fails', async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args)
    try {
      const { events, recovery } = harness({
        readStoredTrades: async () => {
          throw new Error('supabase down')
        },
      })
      await recoverFromLiveFeedFailure(recovery)
      assert.deepEqual(events, ['error:live feed down'])
      assert.equal(warnings.length, 1, 'the fallback failure must be logged, not swallowed')
    } finally {
      console.warn = originalWarn
    }
  })
})
