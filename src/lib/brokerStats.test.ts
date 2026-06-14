import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { MtTrade } from './fxsocketBroker'
import {
  buildPerformanceChannelLinkMaps,
  resolveChannelIdForTrade,
} from './performanceInsights'
import {
  computeBrokerBalanceProfit,
  computeBrokerProfitByChannel,
  computeBrokerStatsSnapshot,
  computeBrokerTodayProfit,
  computeBrokerTotalProfit,
  findActiveAttributedSignalTrades,
  findLastAttributedSignalTrade,
} from './brokerStats'

const TEST_NOW = new Date(2026, 5, 2, 12, 0, 0)
const TEST_CLOSED_TODAY = '2026-06-02T10:00:00'
const TEST_CLOSED_OLD = '2026-05-20T10:00:00'

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
    opened_at: '2026-06-01T10:00:00',
    closed_at: TEST_CLOSED_TODAY,
    state: null,
    status: 'closed',
    ...overrides,
  }
}

test('resolveChannelIdForTrade is exported and resolves ticket attribution', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP Gold' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '42',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const channelId = resolveChannelIdForTrade(
    mtTrade({ broker_id: 'broker-1', ticket: 42, profit: 10 }),
    maps,
  )
  assert.equal(channelId, 'ch-1')
})

test('computeBrokerBalanceProfit is balance delta minus deposit/withdrawal cash flows', () => {
  assert.equal(computeBrokerBalanceProfit(10_000, 10_120), 120)
  assert.equal(computeBrokerBalanceProfit(10_000, 9_850), -150)
  assert.equal(computeBrokerBalanceProfit(null, 10_120), null)

  const withDeposit = [
    mtTrade({
      broker_id: 'broker-1',
      ticket: 1,
      direction: 'buy',
      type: 'Balance',
      lot_size: 0,
      symbol: '',
      profit: 10_000,
      closed_at: TEST_CLOSED_OLD,
    }),
    mtTrade({
      broker_id: 'broker-1',
      ticket: 2,
      profit: 500,
      closed_at: TEST_CLOSED_TODAY,
    }),
  ]
  assert.equal(computeBrokerBalanceProfit(10_000, 20_500, withDeposit, 'broker-1'), 500)
})

test('computeBrokerTodayProfit and total exclude balance rows', () => {
  const trades = [
    mtTrade({
      broker_id: 'broker-1',
      ticket: 1,
      direction: 'buy',
      type: 'Buy Stop Limit',
      lot_size: 0,
      profit: 50_000,
      closed_at: TEST_CLOSED_TODAY,
    }),
    mtTrade({
      broker_id: 'broker-1',
      ticket: 2,
      profit: 80,
      closed_at: TEST_CLOSED_TODAY,
    }),
    mtTrade({
      broker_id: 'broker-1',
      ticket: 3,
      profit: 40,
      closed_at: TEST_CLOSED_OLD,
    }),
  ]
  assert.equal(computeBrokerTodayProfit('broker-1', trades, [], TEST_NOW), 80)
  assert.equal(computeBrokerTotalProfit('broker-1', trades, []), 120)
})

test('findLastAttributedSignalTrade returns newest attributed close', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }, { id: 'ch-2', display_name: 'Beta' }],
    [
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '10',
        signal_id: 'sig-a',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '20',
        signal_id: 'sig-b',
        telegram_channel_id: 'ch-2',
      },
    ],
    [
      { id: 'sig-a', channel_id: 'ch-1' },
      { id: 'sig-b', channel_id: 'ch-2' },
    ],
    [],
  )
  const last = findLastAttributedSignalTrade(
    'broker-1',
    [
      mtTrade({ broker_id: 'broker-1', ticket: 10, profit: 5, closed_at: '2026-06-01T08:00:00' }),
      mtTrade({ broker_id: 'broker-1', ticket: 20, profit: 15, closed_at: '2026-06-02T09:00:00' }),
      mtTrade({ broker_id: 'broker-1', ticket: 99, profit: 999, closed_at: '2026-06-03T09:00:00' }),
    ],
    maps,
  )
  assert.equal(last?.channelLabel, 'Beta')
  assert.equal(last?.pnl, 15)
})

test('findActiveAttributedSignalTrades aggregates open positions per signal channel', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }, { id: 'ch-2', display_name: 'Beta' }],
    [
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '101',
        signal_id: 'sig-a',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '105',
        signal_id: 'sig-a',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '102',
        signal_id: 'sig-b',
        telegram_channel_id: 'ch-2',
      },
    ],
    [
      { id: 'sig-a', channel_id: 'ch-1' },
      { id: 'sig-b', channel_id: 'ch-2' },
    ],
    [],
  )
  const active = findActiveAttributedSignalTrades(
    'broker-1',
    [
      mtTrade({
        broker_id: 'broker-1',
        ticket: 101,
        status: 'open',
        lot_size: 0.1,
        profit: 12,
        opened_at: '2026-06-01T08:00:00',
        closed_at: null,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 105,
        status: 'open',
        lot_size: 0.05,
        profit: 8,
        opened_at: '2026-06-01T09:00:00',
        closed_at: null,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 102,
        status: 'open',
        lot_size: 0.2,
        profit: 25,
        opened_at: '2026-06-02T09:00:00',
        closed_at: null,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 103,
        status: 'open',
        profit: 99,
        opened_at: '2026-06-03T09:00:00',
        closed_at: null,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 104,
        status: 'open',
        direction: 'buy',
        type: 'Buy Stop Limit',
        lot_size: 0,
        profit: 50_000,
        opened_at: '2026-06-03T10:00:00',
        closed_at: null,
      }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 7,
        status: 'closed',
        profit: 120,
        closed_at: TEST_CLOSED_TODAY,
      }),
    ],
    maps,
  )
  assert.equal(active.length, 2)
  assert.equal(active[0]?.channelLabel, 'Beta')
  assert.equal(active[0]?.pnl, 25)
  assert.equal(active[0]?.totalLots, 0.2)
  assert.equal(active[0]?.positionCount, 1)
  assert.equal(active[1]?.channelLabel, 'Alpha')
  assert.equal(active[1]?.pnl, 20)
  assert.ok(Math.abs((active[1]?.totalLots ?? 0) - 0.15) < 1e-9)
  assert.equal(active[1]?.positionCount, 2)
})

test('findActiveAttributedSignalTrades uses swap/commission when profit is null', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '50',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const active = findActiveAttributedSignalTrades(
    'broker-1',
    [
      mtTrade({
        broker_id: 'broker-1',
        ticket: 50,
        status: 'open',
        profit: null,
        swap: -1.5,
        commission: -0.5,
        opened_at: '2026-06-02T11:00:00',
        closed_at: null,
      }),
    ],
    maps,
  )
  assert.equal(active.length, 1)
  assert.equal(active[0]?.pnl, -2)
})

test('computeBrokerProfitByChannel attributes open legs via TSCopier comment slug', () => {
  const channelId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const maps = buildPerformanceChannelLinkMaps([], [], [], [])
  maps.channelNames[channelId] = 'Test Signal Channel'
  const rows = computeBrokerProfitByChannel({
    brokerId: 'broker-1',
    connectedChannelIds: [channelId],
    mtTrades: [
      mtTrade({
        broker_id: 'broker-1',
        ticket: 1705377546,
        status: 'open',
        comment: 'TSCopier:TestSignalCh:4a6c0a6b:',
        profit: -417,
        opened_at: '2026-06-14T16:53:23.000Z',
        closed_at: null,
      }),
    ],
    channelLinkMaps: maps,
    unlinkedChannelLabel: 'Unlinked',
    now: TEST_NOW,
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.key, channelId)
  assert.equal(rows[0]?.pnl, -417)
})

test('computeBrokerProfitByChannel sums closed and open P/L per channel', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP' }, { id: 'ch-2', display_name: 'Beta' }],
    [
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '7',
        signal_id: 'sig-1',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '50',
        signal_id: 'sig-2',
        telegram_channel_id: 'ch-2',
      },
    ],
    [
      { id: 'sig-1', channel_id: 'ch-1' },
      { id: 'sig-2', channel_id: 'ch-2' },
    ],
    [],
  )
  const rows = computeBrokerProfitByChannel({
    brokerId: 'broker-1',
    connectedChannelIds: ['ch-1', 'ch-2'],
    mtTrades: [
      mtTrade({ broker_id: 'broker-1', ticket: 7, profit: 120, closed_at: TEST_CLOSED_TODAY }),
      mtTrade({
        broker_id: 'broker-1',
        ticket: 50,
        status: 'open',
        profit: 35,
        opened_at: '2026-06-02T11:00:00',
        closed_at: null,
      }),
    ],
    channelLinkMaps: maps,
    unlinkedChannelLabel: 'Unlinked',
    now: TEST_NOW,
  })
  assert.equal(rows.length, 2)
  const vip = rows.find(r => r.key === 'ch-1')
  const beta = rows.find(r => r.key === 'ch-2')
  assert.equal(vip?.pnl, 120)
  assert.equal(beta?.pnl, 35)
  assert.equal(beta?.count, 0)
})

test('computeBrokerStatsSnapshot includes initial balance and channel rows', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '7',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const snapshot = computeBrokerStatsSnapshot({
    brokerId: 'broker-1',
    initialBalance: 10_000,
    currentBalance: 10_120,
    currentEquity: 10_150,
    mtTrades: [mtTrade({ broker_id: 'broker-1', ticket: 7, profit: 120, closed_at: TEST_CLOSED_TODAY })],
    chartTrades: [],
    channelLinkMaps: maps,
    connectedChannelIds: ['ch-1'],
    unlinkedChannelLabel: 'Unlinked',
    now: TEST_NOW,
  })
  assert.equal(snapshot.initialBalance, 10_000)
  assert.equal(snapshot.totalProfit, 120)
  assert.equal(snapshot.connectedChannelCount, 1)
  assert.equal(snapshot.profitByChannel[0]?.label, 'VIP')
  assert.equal(snapshot.lastSignalTrade?.channelLabel, 'VIP')
  assert.equal(snapshot.lastSignalTrade?.pnl, 120)
  assert.deepEqual(snapshot.activeSignalTrades, [])
})

test('computeBrokerStatsSnapshot last signal trade shows channel total profit', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'Alpha' }, { id: 'ch-2', display_name: 'Beta' }],
    [
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '10',
        signal_id: 'sig-a',
        telegram_channel_id: 'ch-1',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '20',
        signal_id: 'sig-b',
        telegram_channel_id: 'ch-2',
      },
      {
        broker_account_id: 'broker-1',
        metaapi_order_id: '21',
        signal_id: 'sig-b',
        telegram_channel_id: 'ch-2',
      },
    ],
    [
      { id: 'sig-a', channel_id: 'ch-1' },
      { id: 'sig-b', channel_id: 'ch-2' },
    ],
    [],
  )
  const snapshot = computeBrokerStatsSnapshot({
    brokerId: 'broker-1',
    initialBalance: 10_000,
    currentBalance: 10_120,
    currentEquity: 10_150,
    mtTrades: [
      mtTrade({ broker_id: 'broker-1', ticket: 10, profit: 5, closed_at: '2026-06-01T08:00:00' }),
      mtTrade({ broker_id: 'broker-1', ticket: 20, profit: 15, closed_at: '2026-06-02T09:00:00' }),
      mtTrade({ broker_id: 'broker-1', ticket: 21, profit: 25, closed_at: '2026-06-03T09:00:00' }),
    ],
    chartTrades: [],
    channelLinkMaps: maps,
    connectedChannelIds: ['ch-1', 'ch-2'],
    unlinkedChannelLabel: 'Unlinked',
    now: TEST_NOW,
  })
  assert.equal(snapshot.lastSignalTrade?.channelLabel, 'Beta')
  assert.equal(snapshot.lastSignalTrade?.pnl, 40)
})

test('computeBrokerStatsSnapshot includes active open attributed trades', () => {
  const maps = buildPerformanceChannelLinkMaps(
    [{ id: 'ch-1', display_name: 'VIP' }],
    [{
      broker_account_id: 'broker-1',
      metaapi_order_id: '50',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch-1',
    }],
    [{ id: 'sig-1', channel_id: 'ch-1' }],
    [],
  )
  const snapshot = computeBrokerStatsSnapshot({
    brokerId: 'broker-1',
    initialBalance: 10_000,
    currentBalance: 10_120,
    currentEquity: 10_150,
    mtTrades: [
      mtTrade({
        broker_id: 'broker-1',
        ticket: 50,
        status: 'open',
        profit: 35,
        opened_at: '2026-06-02T11:00:00',
        closed_at: null,
      }),
    ],
    chartTrades: [],
    channelLinkMaps: maps,
    unlinkedChannelLabel: 'Unlinked',
    now: TEST_NOW,
  })
  assert.equal(snapshot.activeSignalTrades.length, 1)
  assert.equal(snapshot.activeSignalTrades[0]?.pnl, 35)
  assert.equal(snapshot.activeSignalTrades[0]?.channelLabel, 'VIP')
})
