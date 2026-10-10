import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  platformIconSrc,
  resolveActivityRoute,
  resolveActivitySourceKind,
} from './activityRoute'
import type { DisplayableTradeActivity } from './tradeActivities'

const mt5 = {
  id: 'broker-1',
  platform: 'MT5',
  label: 'NewEXness',
  broker_name: 'Exness',
  account_login: '100',
}

function activity(partial: Partial<DisplayableTradeActivity['row']> & { channelName?: string | null }): DisplayableTradeActivity {
  return {
    row: {
      id: 'log-1',
      created_at: '2026-10-07T14:54:00Z',
      action: 'order_send',
      status: 'failed',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signal_id: 'sig-1',
      broker_account_id: 'broker-1',
      signals: { channel_id: 'ch-1' },
      ...partial,
    },
    message: 'rejected',
    status: 'failed',
    kind: 'Order',
    symbol: 'XAUUSD',
    channelName: partial.channelName === undefined ? 'GTMO VIP' : partial.channelName,
    retryEligible: false,
  }
}

test('platformIconSrc maps MetaTrader and later destination platforms', () => {
  assert.equal(platformIconSrc('mt5'), '/MT5.png')
  assert.equal(platformIconSrc('MT4'), '/MT4.png')
  assert.equal(platformIconSrc('cTrader'), '/cTrader.png')
  assert.equal(platformIconSrc('Match-Trader'), '/Match-Trader.png')
  assert.equal(platformIconSrc(''), null)
})

test('telegram activities keep a Telegram source and the destination broker platform', () => {
  const route = resolveActivityRoute(activity({}), [mt5])
  assert.equal(route.source?.kind, 'telegram')
  assert.equal(route.source?.iconSrc, '/Telegram.svg')
  assert.equal(route.destination?.kind, 'MT5')
  assert.equal(route.destination?.iconSrc, '/MT5.png')
  assert.equal(route.destination?.label, 'NewEXness')
})

test('a missing broker id leaves the destination mark off', () => {
  const route = resolveActivityRoute(activity({ broker_account_id: null }), [mt5])
  assert.equal(route.source?.kind, 'telegram')
  assert.equal(route.destination, null)
})

test('channel source kind overrides the telegram fallback', () => {
  const row = activity({ channelName: 'Gold room' }).row
  assert.equal(
    resolveActivitySourceKind(row, 'Gold room', { 'ch-1': 'discord' }),
    'discord',
  )
  const route = resolveActivityRoute(
    { row, channelName: 'Gold room', sourceKind: 'discord' },
    [mt5],
  )
  assert.equal(route.source?.kind, 'discord')
  assert.equal(route.source?.iconSrc, '/discord-logo.png')
  assert.equal(route.source?.label, 'Discord · Gold room')

  const tradingView = resolveActivityRoute(
    { row, channelName: 'TV alerts', sourceKind: 'tradingview' },
    [mt5],
  )
  assert.equal(tradingView.source?.iconSrc, '/tradingview-logo.png')
  assert.equal(tradingView.source?.label, 'TradingView · TV alerts')
})

test('source_kind selects a non-telegram source', () => {
  const row = activity({
    signals: null,
    channelName: null,
    request_payload: { source_kind: 'whatsapp' },
  }).row
  assert.equal(resolveActivitySourceKind(row, null), 'whatsapp')
  const route = resolveActivityRoute(
    { row, channelName: null },
    [mt5],
  )
  assert.equal(route.source?.kind, 'whatsapp')
  assert.equal(route.source?.iconSrc, '/whatsapp-icon.png')
  assert.equal(route.destination?.iconSrc, '/MT5.png')
})

test('broker copy uses the source account platform as the source mark', () => {
  const route = resolveActivityRoute(
    activity({
      signals: null,
      channelName: null,
      request_payload: { source_kind: 'broker', source_broker_account_id: 'broker-1' },
      broker_account_id: 'broker-2',
    }),
    [mt5, { ...mt5, id: 'broker-2', platform: 'MT4', label: 'New Con' }],
  )
  assert.equal(route.source?.kind, 'broker')
  assert.equal(route.source?.iconSrc, '/MT5.png')
  assert.equal(route.source?.label, 'NewEXness')
  assert.equal(route.destination?.kind, 'MT4')
  assert.equal(route.destination?.label, 'New Con')
})
