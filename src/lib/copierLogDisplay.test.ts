import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  resolveRecentChannelEntrySymbol,
  symbolForCopierLog,
} from './copierLogDisplay'
import type { Signal } from '../types/database'

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
