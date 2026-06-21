import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  formatTradeSignalSummary,
  isTelegramTradeSignal,
  resolveRecentChannelEntrySymbol,
  symbolForCopierLog,
  type TradeSignalSummaryLabels,
} from './copierLogDisplay'
import type { Signal } from '../types/database'

const summaryLabels: TradeSignalSummaryLabels = {
  actionBuy: 'Buy',
  actionSell: 'Sell',
  actionClose: 'Close',
  actionCloseWorseEntries: 'Close worse entries',
  actionBreakeven: 'Move SL to break-even',
  actionModify: 'Update SL/TP',
  actionPartialProfit: 'Take partial profit',
  actionPartialBreakeven: 'Partial profit + break-even',
  onSymbol: 'on {symbol}',
  entryAt: 'Entry {price}',
  slAt: 'SL {price}',
  tpAt: 'TP {prices}',
}

function signal(partial: Partial<Signal> & Pick<Signal, 'id'>): Signal {
  return {
    user_id: 'u1',
    channel_id: 'ch1',
    raw_message: '',
    raw_image_url: null,
    status: 'executed',
    skip_reason: null,
    telegram_message_id: null,
    is_modification: false,
    parent_signal_id: null,
    created_at: '2026-06-14T18:00:00.000Z',
    parsed_data: null,
    ...partial,
  }
}

test('resolveRecentChannelEntrySymbol picks latest buy/sell before management row', () => {
  const buy = signal({
    id: 'buy1',
    created_at: '2026-06-14T17:00:00.000Z',
    parsed_data: { action: 'buy', symbol: 'BTCUSD' },
  })
  const modify = signal({
    id: 'mod1',
    created_at: '2026-06-14T18:00:00.000Z',
    is_modification: true,
    parsed_data: { action: 'modify' },
  })

  assert.equal(resolveRecentChannelEntrySymbol(modify, [modify, buy]), 'BTCUSD')
})

test('symbolForCopierLog uses channel entry fallback when parent is missing', () => {
  const buy = signal({
    id: 'buy1',
    created_at: '2026-06-14T17:00:00.000Z',
    parsed_data: { action: 'buy', symbol: 'BTCUSD' },
  })
  const close = signal({
    id: 'close1',
    created_at: '2026-06-14T18:00:00.000Z',
    is_modification: true,
    parsed_data: { action: 'close' },
  })
  const context = {
    lookup: new Map([
      [buy.id, {
        id: buy.id,
        parsed_data: buy.parsed_data,
        raw_message: buy.raw_message,
        parent_signal_id: buy.parent_signal_id,
      }],
      [close.id, {
        id: close.id,
        parsed_data: close.parsed_data,
        raw_message: close.raw_message,
        parent_signal_id: close.parent_signal_id,
      }],
    ]),
    replyParentBySignalId: new Map(),
  }

  assert.equal(symbolForCopierLog(close, context, [close, buy]), 'BTCUSD')
})

test('symbolForCopierLog prefers parent chain over channel fallback', () => {
  const parent = signal({
    id: 'parent1',
    parsed_data: { action: 'buy', symbol: 'ETHUSD' },
  })
  const modify = signal({
    id: 'mod1',
    parent_signal_id: 'parent1',
    is_modification: true,
    parsed_data: { action: 'modify' },
  })
  const otherBuy = signal({
    id: 'buy2',
    created_at: '2026-06-14T19:00:00.000Z',
    parsed_data: { action: 'buy', symbol: 'BTCUSD' },
  })
  const context = {
    lookup: new Map([
      [parent.id, {
        id: parent.id,
        parsed_data: parent.parsed_data,
        raw_message: parent.raw_message,
        parent_signal_id: parent.parent_signal_id,
      }],
    ]),
    replyParentBySignalId: new Map(),
  }

  assert.equal(symbolForCopierLog(modify, context, [modify, otherBuy]), 'ETHUSD')
})

test('isTelegramTradeSignal excludes ignore and non-trade rows', () => {
  assert.equal(
    isTelegramTradeSignal({
      channel_id: 'ch1',
      parsed_data: { action: 'buy', symbol: 'XAUUSD' },
      skip_reason: null,
    }),
    true,
  )
  assert.equal(
    isTelegramTradeSignal({
      channel_id: 'ch1',
      parsed_data: { action: 'ignore' },
      skip_reason: 'non_trade_message',
    }),
    false,
  )
  assert.equal(
    isTelegramTradeSignal({
      channel_id: null,
      parsed_data: { action: 'sell' },
      skip_reason: null,
    }),
    false,
  )
})

test('formatTradeSignalSummary renders plain buy line', () => {
  const buy = signal({
    id: 'buy1',
    parsed_data: { action: 'buy', symbol: 'XAUUSD', entry: 2650, sl: 2640, tp: [2670, 2680] },
  })
  const context = { lookup: new Map(), replyParentBySignalId: new Map() }
  const summary = formatTradeSignalSummary(buy, context, [buy], summaryLabels)
  assert.match(summary, /Buy on XAUUSD/)
  assert.match(summary, /Entry 2650/)
  assert.match(summary, /SL 2640/)
  assert.match(summary, /TP 2670, 2680/)
})
