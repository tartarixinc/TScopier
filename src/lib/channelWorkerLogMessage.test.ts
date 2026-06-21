import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { channelWorkerEn } from '../i18n/channelWorker/en'
import { channelWorkerLogMessage } from './channelWorkerLogMessage'

test('channelWorkerLogMessage: shows skipped breakeven management', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'dispatch_skipped',
      status: 'skipped',
      request_payload: { skip_reason: 'channel_filter_ignored' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'breakeven', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'channel_filter_ignored',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.ok(message)
  assert.match(message!, /Did not copy|Ignore/i)
})

test('channelWorkerLogMessage: shows skipped modify via mgmt log', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'mgmt_modify',
      status: 'skipped',
      request_payload: { skip_reason: 'mgmt_no_open_trades' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'modify', symbol: 'XAUUSD' },
        status: 'skipped',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Fredtrading' },
  )
  assert.ok(message)
  assert.match(message!, /modify|stop|open trade/i)
})

test('channelWorkerLogMessage: still hides non-trade commentary', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'pipeline_parse_dispatch',
      status: 'success',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        parsed_data: { action: 'ignore' },
        skip_reason: 'non_trade_message',
      },
    },
    channelWorkerEn,
  )
  assert.equal(message, null)
})
