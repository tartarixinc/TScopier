import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { MtTrade } from './metatraderapi'
import {
  buildPerformanceChannelLinkMaps,
  computeProfitByChannel,
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
  assert.equal(maps.ticketToChannelId['broker-1:12345'], 'ch-1')
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
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.key, 'ch-1')
  assert.equal(rows[0]!.label, 'Signal Tester')
  assert.equal(rows[0]!.pnl, 42)
})

test('computeProfitByChannel: maps via TSCopier comment signal prefix', () => {
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
      comment: 'TSCopier:VIPGoldSigna:28785f02',
      profit: 10,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  assert.equal(rows[0]!.key, 'ch-1')
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
      comment: 'TSCopier:vipgold:deadbeef',
      profit: 5,
      closed_at: TEST_CLOSED_AT,
    })],
    'all',
    maps,
    'Unlinked',
    TEST_NOW,
  )
  assert.equal(rows[0]!.key, 'ch-2')
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
  assert.notEqual(rows[0]!.key, UNLINKED_CHANNEL_KEY)
  assert.equal(rows[0]!.key, 'ch-1')
})
