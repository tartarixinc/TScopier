import { describe, test, expect } from 'vitest'
import type { MtTrade } from './fxsocketBroker'
import {
  buildPerformanceChannelLinkMaps,
  computeProfitByChannel,
  normalizeChannelLinkMaps,
  resolveChannelIdForTrade,
  resolveSignalIdForTrade,
  UNLINKED_CHANNEL_KEY,
} from './performanceInsights'

const TEST_NOW = new Date('2026-06-02T18:00:00.000Z')
const TEST_CLOSED_AT = '2026-06-02T12:00:00.000Z'

function mtTrade(overrides: Partial<MtTrade> & Pick<MtTrade, 'broker_id' | 'ticket'>): MtTrade {
  return {
    id: `${overrides.broker_id}:${overrides.ticket}`,
    broker_label: 'Acct',
    broker_name: 'Broker',
    symbol: 'XAUUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.1,
    entry_price: 2500,
    sl: null,
    tp: null,
    close_price: 2510,
    profit: 100,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: '2026-06-01T10:00:00.000Z',
    closed_at: TEST_CLOSED_AT,
    state: null,
    status: 'closed',
    ...overrides,
  }
}

test('buildPerformanceChannelLinkMaps: ticket keys normalize numeric variants', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP Gold Signals' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '12345',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  expect(maps.ticketToChannelId['broker-1:12345']).toBe('ch-1')
  expect(maps.ticketToSignalId['broker-1:12345']).toBe('sig-1')
})

test('normalizeChannelLinkMaps backfills ticketToSignalId from older cache payloads', () => {
  const maps = normalizeChannelLinkMaps({
    ticketToChannelId: { 'broker-1:1': 'ch-1' },
    signalPrefixToChannelId: {},
    channelSlugToChannelId: {},
    channelNames: { 'ch-1': 'VIP' },
  })
  expect(maps.ticketToSignalId).toEqual({})
  expect(resolveSignalIdForTrade(
    mtTrade({ broker_id: 'broker-1', ticket: 1, comment: null }),
    maps,
  )).toBe(null)
})

test('computeProfitByChannel: maps closed MT trade via DB ticket attribution', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Signal Tester' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '999',
      signal_id: '28785f02-000b-4860-a3dd-58d74f890a5d',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: '28785f02-000b-4860-a3dd-58d74f890a5d', channel_id: 'ch-1' }],
    [],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 999,
      profit: 42,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows.length).toBe(1)
  expect(rows[0]!.key).toBe('ch-1')
  expect(rows[0]!.label).toBe('Signal Tester')
  expect(rows[0]!.pnl).toBe(42)
})

test('computeProfitByChannel: maps via TScopier comment signal prefix', () => {
  const signalId = '28785f02-000b-4860-a3dd-58d74f890a5d'
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP Gold Signals' }],
    [],
    [{ id: signalId, channel_id: 'ch-1' }],
    [],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 555,
      comment: 'TScopier:VIPGoldSigna:28785f02',
      profit: 10,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows[0]!.key).toBe('ch-1')
})

test('computeProfitByChannel: maps via comment channel slug not display name substring', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-2', display_name: 'My Channel', channel_username: 'vipgold' }],
    [],
    [],
    [],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 777,
      comment: 'TScopier:vipgold:deadbeef',
      profit: 5,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows[0]!.key).toBe('ch-2')
})

test('computeProfitByChannel: excludes MT4 balance top-up rows', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP Gold Signals' }],
    [
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '888',
        signal_id: 'sig-1',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '889',
        signal_id: 'sig-1',
        telegram_channel_id: 'ch-1',
      },
    ],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const rows = computeProfitByChannel(
    [
      mtTrade({
        broker_id: 'broker-1',
        ticket: 888,
        direction: 'buy',
        type: 'Buy Stop Limit',
        lot_size: 0,
        profit: 50_000,
        closed_at: TEST_CLOSED_AT,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 889,
        profit: 75,
        closed_at: TEST_CLOSED_AT,
      }),
    ],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows.length).toBe(1)
  expect(rows[0]!.key).toBe('ch-1')
  expect(rows[0]!.pnl).toBe(75)
  expect(rows[0]!.count).toBe(1)
})

test('computeProfitByChannel: omits unlinked manual trades from chart rows', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP Gold Signals' }],
    [],
    [],
    [],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 100,
      profit: 999,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked / manual',
    TEST_NOW,
  )
  expect(rows.length).toBe(0)
})

test('resolveChannelIdForTrade: attributes MT5 close deal via position_ticket', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '5001',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const channelId = resolveChannelIdForTrade(
    mtTrade({
      broker_id: 'broker-1',
      ticket: 9009,
      position_ticket: 5001,
      profit: 30,
      closed_at: TEST_CLOSED_AT,
    }),
    maps,
  )
  expect(channelId).toBe('ch-1')
})

test('computeProfitByChannel: attributes close deal profit via position_ticket', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '5001',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 9009,
      position_ticket: 5001,
      profit: 30,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows.length).toBe(1)
  expect(rows[0]!.pnl).toBe(30)
})

test('computeProfitByChannel: uses durable attribution when ticket differs in formatting', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }],
    [],
    [],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '1001.0',
      signal_id: 'sig-1',
      channel_id: 'ch-1',
      channel_label: 'Alpha',
    }],
  )
  const rows = computeProfitByChannel(
    [mtTrade({
      broker_id: 'broker-1',
      ticket: 1001,
      profit: 20,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  expect(rows[0]!.key).not.toBe(UNLINKED_CHANNEL_KEY)
  expect(rows[0]!.key).toBe('ch-1')
})

test('resolveChannelIdForTrade: attributes via TScopier slug on connected channel only', () => {
  const channelId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const maps = buildPerformanceChannelLinkMaps([], [], [], [])
  maps.channelNames[channelId] = 'Test Signal Channel'
  const resolved = resolveChannelIdForTrade(
    mtTrade({
      broker_id: 'broker-1',
      ticket: 1705377546,
      status: 'open',
      comment: 'TScopier:TestSignalCh:4a6c0a6b:',
      profit: -7.86,
      opened_at: '2026-06-14T16:53:23.000Z',
      closed_at: null,
    }),
    maps,
    { connectedChannelIds: [channelId] },
  )
  expect(resolved).toBe(channelId)
})

test('resolveChannelIdForTrade: single connected channel TScopier fallback', () => {
  const channelId = 'ch-only'
  const maps = buildPerformanceChannelLinkMaps([], [], [], [])
  maps.channelNames[channelId] = 'VIP'
  const resolved = resolveChannelIdForTrade(
    mtTrade({
      broker_id: 'broker-1',
      ticket: 1,
      status: 'open',
      comment: 'TScopier:UnknownSlug:deadbeef',
      profit: 5,
      opened_at: '2026-06-14T16:53:23.000Z',
      closed_at: null,
    }),
    maps,
    { connectedChannelIds: [channelId] },
  )
  expect(resolved).toBe(channelId)
})
