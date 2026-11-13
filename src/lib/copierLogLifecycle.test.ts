import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildClosedCopierLogDraft,
  formatCopierCloseReasonShort,
  resolveCopierDisplayReason,
  resolveCopierDisplayStatus,
  type CopierLifecycleReasonLabels,
} from './copierLogLifecycle'
import type { Signal } from '../types/database'

const labels: CopierLifecycleReasonLabels = {
  reasonParsed: 'Signal parsed from Telegram.',
  reasonExecuted: 'Order placed on broker.',
  reasonOpen: 'Due to a trading signal from Telegram.',
  reasonFallback: 'See signal details for more information.',
  closeReasons: {
    news_pre_close: 'Closed ahead of news.',
    signal_close: 'Closed by signal.',
    signal_revision: 'Closed by signal revision.',
    opposite_signal: 'Closed by opposite signal.',
    partial_tp: 'Partial take profit.',
    auto_management: 'Closed by auto-management.',
    close_worse_entries: 'Worse entries closed.',
    copy_limit_flatten: 'Closed by copy limit.',
    user_force_close: 'Closed manually.',
    position_gone: 'Closed on broker.',
    mirror_source_closed: 'Master position closed.',
    mirror_copy_closed: 'Mirror copy closed.',
    stop_loss: 'Due to stop loss.',
    take_profit: 'TP hit.',
    unknown: 'Position closed.',
  },
}

function signal(partial: Partial<Signal> & Pick<Signal, 'id'>): Signal {
  return {
    id: partial.id,
    user_id: 'u1',
    channel_id: partial.channel_id ?? 'ch1',
    raw_message: partial.raw_message ?? 'BUY XAUUSD',
    parsed_data: partial.parsed_data ?? { action: 'buy', symbol: 'XAUUSD' },
    status: partial.status ?? 'executed',
    skip_reason: partial.skip_reason ?? null,
    created_at: partial.created_at ?? '2026-11-13T10:00:00.000Z',
    parent_signal_id: partial.parent_signal_id ?? null,
    is_modification: false,
    telegram_message_id: null,
    reply_to_telegram_message_id: null,
  } as Signal
}

test('resolveCopierDisplayStatus remaps executed + open trades to open', () => {
  const s = signal({ id: 'sig-1', status: 'executed' })
  assert.equal(resolveCopierDisplayStatus('executed', new Set(['sig-1']), s), 'open')
  assert.equal(resolveCopierDisplayStatus('executed', new Set(), s), 'executed')
  assert.equal(resolveCopierDisplayStatus('parsed', new Set(['sig-1']), s), 'parsed')
  assert.equal(resolveCopierDisplayStatus('skipped', new Set(), s), 'skipped')
})

test('resolveCopierDisplayReason fills lifecycle and skip reasons', () => {
  assert.equal(
    resolveCopierDisplayReason('open', null, labels, { skipReasons: {} }),
    'Due to a trading signal from Telegram.',
  )
  assert.equal(
    resolveCopierDisplayReason('executed', null, labels, { skipReasons: {} }),
    'Order placed on broker.',
  )
  assert.equal(
    resolveCopierDisplayReason('parsed', null, labels, { skipReasons: {} }),
    'Signal parsed from Telegram.',
  )
  assert.equal(
    resolveCopierDisplayReason('skipped', 'copier_paused', labels, {
      skipReasons: { copier_paused: 'Copier is paused' },
    }),
    'Copier is paused',
  )
  assert.equal(
    resolveCopierDisplayReason('failed', null, labels, { skipReasons: {} }),
    labels.reasonFallback,
  )
})

test('formatCopierCloseReasonShort maps SL/TP and stored codes', () => {
  assert.equal(
    formatCopierCloseReasonShort(
      { close_reason: null, sl: 2640, tp: 2670, close_price: 2640 },
      labels.closeReasons,
    ),
    'Due to stop loss.',
  )
  assert.equal(
    formatCopierCloseReasonShort(
      { close_reason: null, sl: 2640, tp: 2670, close_price: 2670 },
      labels.closeReasons,
    ),
    'TP hit.',
  )
  assert.equal(
    formatCopierCloseReasonShort(
      { close_reason: 'signal_close', sl: null, tp: null, close_price: null },
      labels.closeReasons,
    ),
    'Closed by signal.',
  )
})

test('buildClosedCopierLogDraft builds synthetic Closed row', () => {
  const draft = buildClosedCopierLogDraft(
    {
      id: 'tr-1',
      signal_id: 'sig-1',
      telegram_channel_id: 'ch1',
      symbol: 'XAUUSD',
      direction: 'buy',
      closed_at: '2026-11-13T12:00:00.000Z',
      close_reason: null,
      sl: 2640,
      tp: 2670,
      close_price: 2670,
    },
    labels,
  )
  assert.equal(draft.key, 'trade-close:tr-1')
  assert.equal(draft.status, 'closed')
  assert.equal(draft.reason, 'TP hit.')
  assert.equal(draft.symbol, 'XAUUSD')
  assert.equal(draft.at, '2026-11-13T12:00:00.000Z')
})
