import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildManualSourceTradeActivities,
  buildSocialCopyTradeActivities,
  countSocialCopyOpensInRange,
  fetchManualSourceTradeLogs,
  fetchSocialCopyLogs,
  normalizeSocialCopyLogs,
  normalizeSocialProviderSourceTrades,
  synthesizeSocialCopyLogsFromMappings,
} from './socialCopyLogs'

const SUB_ID = '31ca68fd-0000-4000-8000-000000000001'

const openEvent = {
  id: 'e1',
  subscription_id: SUB_ID,
  mapping_id: 'm1',
  source_ticket: '547044465',
  action: 'open',
  status: 'succeeded',
  request_payload: { symbol: 'BTCUSDm', volume: 0.01, side: 'buy' },
  error_detail: null,
  created_at: '2026-11-07T19:46:14Z',
}

const mapping = {
  id: 'm1',
  subscription_id: SUB_ID,
  source_ticket: '547044465',
  source_symbol: 'BTCUSDm',
  destination_symbol: 'BTCUSDm',
  source_side: 'buy',
  source_volume: 0.01,
  destination_volume: 0.01,
  destination_ticket: '3442375631',
  state: 'open',
  opened_at: '2026-11-07T19:46:14Z',
  closed_at: null,
  created_at: '2026-11-07T19:46:13Z',
  last_error_detail: null,
}

const subscriptions = [
  {
    id: SUB_ID,
    source_trader_user_id: 'trader-1',
    destination_broker_account_id: 'dst-1',
  },
]

const brokers = [
  { id: 'dst-1', label: 'MT5 • 477608729', account_login: '477608729' },
]

const providerNames = { 'trader-1': 'Amina' }

describe('normalizeSocialCopyLogs', () => {
  it('turns a successful open into an executed row with provider name', () => {
    expect(normalizeSocialCopyLogs([openEvent], [mapping], subscriptions, brokers, providerNames)).toEqual([
      {
        id: 'e1',
        createdAt: '2026-11-07T19:46:14Z',
        status: 'executed',
        action: 'open',
        side: 'buy',
        symbol: 'BTCUSDm',
        sourceTicket: '547044465',
        lot: 0.01,
        channelName: 'Amina',
        destinationAccount: 'MT5 • 477608729',
        destinationTicket: '3442375631',
        destinationBrokerAccountId: 'dst-1',
        reason: null,
      },
    ])
  })

  it('falls back to Provider when the directory has no name', () => {
    const rows = normalizeSocialCopyLogs([openEvent], [mapping], subscriptions, brokers, {})
    expect(rows[0]!.channelName).toBe('Provider')
  })
})

describe('synthesizeSocialCopyLogsFromMappings', () => {
  it('builds open rows from existing mappings when events are missing', () => {
    const rows = synthesizeSocialCopyLogsFromMappings([mapping], subscriptions, brokers, providerNames)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'mapping:m1:open',
      status: 'executed',
      action: 'open',
      side: 'buy',
      channelName: 'Amina',
      destinationTicket: '3442375631',
    })
  })

  it('adds a close row when the mapping is closed', () => {
    const rows = synthesizeSocialCopyLogsFromMappings(
      [{ ...mapping, state: 'closed', closed_at: '2026-11-07T20:00:00Z' }],
      subscriptions,
      brokers,
      providerNames,
    )
    expect(rows.map(r => r.action)).toEqual(['close', 'open'])
  })
})

describe('buildSocialCopyTradeActivities', () => {
  it('maps executed opens into successful order activities', () => {
    const [row] = normalizeSocialCopyLogs([openEvent], [mapping], subscriptions, brokers, providerNames)
    const activities = buildSocialCopyTradeActivities([row!], {
      kindOrder: 'Order',
      kindClose: 'Close',
      kindModify: 'Modify',
      kindOther: 'Other',
    }, {
      source: 'Social trading',
      openMessage: 'Copied {detail} from provider #{ticket}',
      closeMessage: 'Social copy of #{ticket} closed',
      modifyMessage: 'Social copy of #{ticket} updated',
      otherMessage: '{action} · social copy of #{ticket}',
    })
    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      status: 'successful',
      kind: 'Order',
      symbol: 'BTCUSDm',
      channelName: 'Social trading · Amina',
      retryEligible: false,
    })
    expect(activities[0]!.message).toContain('BTCUSDm')
    expect(activities[0]!.row.broker_account_id).toBe('dst-1')
    expect(activities[0]!.row.request_payload).toMatchObject({ source_kind: 'social' })
  })
})

describe('buildManualSourceTradeActivities', () => {
  it('labels provider source trades as Manual Execution', () => {
    const rows = normalizeSocialProviderSourceTrades(
      [{
        id: 't1',
        broker_account_id: 'src-1',
        symbol: 'BTCUSDm',
        direction: 'buy',
        lot_size: 0.1,
        status: 'open',
        opened_at: '2026-11-07T20:00:00Z',
        closed_at: null,
        metaapi_order_id: '547044465',
        broker_position_ticket: '547044465',
      }],
      { 'src-1': 'MT5 • 476205231' },
    )
    const activities = buildManualSourceTradeActivities(rows, {
      kindOrder: 'Order',
      kindClose: 'Close',
      kindModify: 'Modify',
      kindOther: 'Other',
    }, {
      source: 'Manual Execution',
      openMessage: 'Opened {detail} #{ticket}',
      closeMessage: 'Closed #{ticket}',
      modifyMessage: 'Updated #{ticket}',
      otherMessage: '{action} · #{ticket}',
    })
    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      channelName: 'Manual Execution · MT5 • 476205231',
      message: 'Opened buy BTCUSDm (0.1 lot) #547044465',
    })
    expect(activities[0]!.row.id).toBe('manual:provider-trade:t1:open')
    expect(activities[0]!.row.request_payload).toMatchObject({ source_kind: 'manual' })
  })
})

function chain(result: { data: unknown; error: unknown }) {
  const api: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'order', 'limit', 'eq', 'not']) api[method] = () => api
  api.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return api
}

function fakeSupabase(tables: Record<string, { data: unknown; error: unknown }>, rpcData: unknown = []): SupabaseClient {
  return {
    from(table: string) {
      return { select: () => chain(tables[table] ?? { data: [], error: null }) }
    },
    rpc() {
      return Promise.resolve({ data: rpcData, error: null })
    },
  } as unknown as SupabaseClient
}

describe('normalizeSocialProviderSourceTrades', () => {
  it('turns a published-source broker trade into an open log row', () => {
    const rows = normalizeSocialProviderSourceTrades(
      [{
        id: 't1',
        broker_account_id: 'src-1',
        symbol: 'BTCUSDm',
        direction: 'buy',
        lot_size: 0.02,
        status: 'open',
        opened_at: '2026-11-07T20:00:00Z',
        closed_at: null,
        metaapi_order_id: '547044465',
        broker_position_ticket: '547044465',
      }],
      { 'src-1': 'MT5 • 476205231' },
    )
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'provider-trade:t1:open',
        status: 'executed',
        action: 'open',
        side: 'buy',
        symbol: 'BTCUSDm',
        sourceTicket: '547044465',
        channelName: 'MT5 • 476205231',
      }),
    ])
  })

  it('excludes signal-linked fills so TradingView/Telegram copies are not Manual Execution', () => {
    const rows = normalizeSocialProviderSourceTrades(
      [{
        id: 'tv-fill',
        broker_account_id: 'src-1',
        symbol: 'XAUUSDm',
        direction: 'sell',
        lot_size: 0.01,
        status: 'open',
        opened_at: '2026-11-10T20:39:00Z',
        closed_at: null,
        metaapi_order_id: '1',
        broker_position_ticket: '1',
        signal_id: 'signal-tv-1',
      }, {
        id: 'manual-fill',
        broker_account_id: 'src-1',
        symbol: 'BTCUSDm',
        direction: 'buy',
        lot_size: 0.1,
        status: 'open',
        opened_at: '2026-11-10T20:40:00Z',
        closed_at: null,
        metaapi_order_id: '2',
        broker_position_ticket: '2',
        signal_id: null,
      }],
      { 'src-1': 'MT5 • 476205231' },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'provider-trade:manual-fill:open', symbol: 'BTCUSDm' })
  })
})

describe('countSocialCopyOpensInRange', () => {
  it('returns 0 when the user has no subscriptions', async () => {
    const client = fakeSupabase({ social_copy_subscriptions: { data: [], error: null } })
    expect(await countSocialCopyOpensInRange(client, 'user-1', '2026-11-07T00:00:00Z', '2026-11-08T00:00:00Z')).toBe(0)
  })

  it('returns the exact count of succeeded opens in range', async () => {
    const client = {
      from(table: string) {
        if (table === 'social_copy_subscriptions') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: subscriptions, error: null }),
            }),
          }
        }
        const api: Record<string, unknown> = {}
        for (const method of ['select', 'in', 'eq', 'gte', 'lt', 'not']) api[method] = () => api
        api.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ count: 3, error: null, data: null }).then(resolve)
        return api
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as SupabaseClient
    expect(await countSocialCopyOpensInRange(client, 'user-1', '2026-11-07T00:00:00Z', '2026-11-08T00:00:00Z')).toBe(3)
  })
})

describe('fetchSocialCopyLogs', () => {
  it('returns [] when the user has no subscriptions', async () => {
    const client = fakeSupabase({
      social_copy_subscriptions: { data: [], error: null },
      social_copy_sources: { data: [], error: null },
    })
    expect(await fetchSocialCopyLogs(client, 'user-1')).toEqual([])
  })

  it('hides Social trading rows for published providers', async () => {
    const client = fakeSupabase({
      social_copy_sources: {
        data: [{ id: 'src', broker_account_id: 'src-1', label: 'Source' }],
        error: null,
      },
      social_copy_subscriptions: { data: subscriptions, error: null },
      social_copy_execution_events: { data: [openEvent], error: null },
      social_copy_trade_mappings: { data: [mapping], error: null },
      broker_accounts: { data: brokers, error: null },
    }, [{ profile_user_id: 'trader-1', display_name: 'Amina' }])
    expect(await fetchSocialCopyLogs(client, 'user-1')).toEqual([])
  })

  it('normalises events when the ledger has rows', async () => {
    const client = fakeSupabase({
      social_copy_sources: { data: [], error: null },
      social_copy_subscriptions: { data: subscriptions, error: null },
      social_copy_execution_events: { data: [openEvent], error: null },
      social_copy_trade_mappings: { data: [mapping], error: null },
      broker_accounts: { data: brokers, error: null },
    }, [{ profile_user_id: 'trader-1', display_name: 'Amina' }])
    const rows = await fetchSocialCopyLogs(client, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'executed', channelName: 'Amina', side: 'buy' })
  })

  it('falls back to mappings when events are empty', async () => {
    const client = fakeSupabase({
      social_copy_sources: { data: [], error: null },
      social_copy_subscriptions: { data: subscriptions, error: null },
      social_copy_execution_events: { data: [], error: null },
      social_copy_trade_mappings: { data: [mapping], error: null },
      broker_accounts: { data: brokers, error: null },
    }, [{ profile_user_id: 'trader-1', display_name: 'Amina' }])
    const rows = await fetchSocialCopyLogs(client, 'user-1')
    expect(rows[0]?.id).toBe('mapping:m1:open')
  })

  it('does not include provider-owned source trades (those are Manual Execution)', async () => {
    const client = fakeSupabase({
      social_copy_subscriptions: { data: [], error: null },
      social_copy_sources: {
        data: [{ id: 'src', broker_account_id: 'src-1', label: 'Source' }],
        error: null,
      },
      trades: {
        data: [{
          id: 't1',
          broker_account_id: 'src-1',
          symbol: 'BTCUSDm',
          direction: 'buy',
          lot_size: 0.1,
          status: 'open',
          opened_at: '2026-11-07T20:00:00Z',
          closed_at: null,
          metaapi_order_id: '1',
          broker_position_ticket: '1',
        }],
        error: null,
      },
      broker_accounts: { data: [{ id: 'src-1', label: 'MT5', account_login: '1' }], error: null },
    })
    const social = await fetchSocialCopyLogs(client, 'user-1')
    expect(social).toEqual([])
    expect(social.every(row => !row.id.startsWith('provider-trade:'))).toBe(true)
  })
})

describe('fetchManualSourceTradeLogs', () => {
  it('returns provider-owned published-source trades', async () => {
    const client = {
      from(table: string) {
        if (table === 'social_copy_sources') {
          return {
            select: () => ({
              eq: () => ({
                in: () => Promise.resolve({
                  data: [{ id: 'src', broker_account_id: 'src-1', label: 'Source' }],
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'trades') {
          const api: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit']) api[method] = () => api
          api.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: [{
                id: 't1',
                broker_account_id: 'src-1',
                symbol: 'BTCUSDm',
                direction: 'buy',
                lot_size: 0.1,
                status: 'open',
                opened_at: '2026-11-07T20:00:00Z',
                closed_at: null,
                metaapi_order_id: '547044465',
                broker_position_ticket: '547044465',
                signal_id: null,
              }],
              error: null,
            }).then(resolve)
          return api
        }
        if (table === 'broker_accounts') {
          const api: Record<string, unknown> = {}
          for (const method of ['select', 'in']) api[method] = () => api
          api.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: [{ id: 'src-1', label: 'MT5 • 476205231', account_login: '476205231' }],
              error: null,
            }).then(resolve)
          return api
        }
        return { select: () => chain({ data: [], error: null }) }
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as SupabaseClient

    const rows = await fetchManualSourceTradeLogs(client, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'provider-trade:t1:open',
      symbol: 'BTCUSDm',
      channelName: 'Source',
    })
  })
})
