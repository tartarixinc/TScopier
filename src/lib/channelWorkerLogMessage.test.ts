import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { channelWorkerEn } from '../i18n/channelWorker/en'
import { channelWorkerLogMessage, filterChannelWorkerDisplayLogs } from './channelWorkerLogMessage'

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

test('channelWorkerLogMessage: virtual_pending_fired success remaps when signal skipped', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'virtual_pending_fired',
      status: 'success',
      request_payload: { symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'channel_config_incomplete',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.ok(message)
  assert.doesNotMatch(message!, /Layered entry order triggered/i)
  assert.match(message!, /Did not place an order/i)
  assert.match(message!, /incomplete/i)
})

test('channelWorkerLogMessage: mgmt success remaps when signal skipped', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'mgmt_modify',
      status: 'success',
      request_payload: { symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'modify', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'no_matching_open_trade',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.ok(message)
  assert.doesNotMatch(message!, /Applied the update/i)
  assert.match(message!, /Skipped the XAUUSD update/i)
  assert.match(message!, /no matching open trade/i)
})

test('channelWorkerLogMessage: completed sell fallback remaps when signal skipped', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'handle_end',
      status: 'success',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'EURUSD' },
        status: 'skipped',
        skip_reason: 'broker_session_not_connected',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: unknown success action remaps sell when signal skipped', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'some_internal_step',
      status: 'success',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'EURUSD' },
        status: 'skipped',
        skip_reason: 'broker_session_not_connected',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.ok(message)
  assert.doesNotMatch(message!, /^Completed: sell/i)
  assert.match(message!, /Did not copy this signal/i)
  assert.match(message!, /broker not connected/i)
})

test('channelWorkerLogMessage: dispatch_route_decision does not show false Completed sell', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'dispatch_route_decision',
      status: 'success',
      request_payload: { queue_enqueued: true },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        status: 'parsed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS 2' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: unknown success does not show Completed sell while signal still parsed', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'queue_consume_ack',
      status: 'success',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        status: 'parsed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS 2' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: pipeline_summary does not show false Completed sell', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'pipeline_summary',
      status: 'success',
      request_payload: { pipeline_ms: 1200 },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        status: 'parsed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS PRO' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: hides pipeline success when mgmt close found no open trades', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'pipeline_parse_dispatch',
      status: 'success',
      request_payload: { symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'close', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'mgmt_no_open_trades_broker',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS PRO' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: mgmt_skip shows single close skipped line', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'mgmt_skip',
      status: 'skipped',
      request_payload: { skip_reason: 'mgmt_no_open_trades_broker' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'close', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'mgmt_no_open_trades_broker',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS PRO' },
  )
  assert.ok(message)
  assert.match(message!, /Did not close/i)
  assert.match(message!, /no open position on the broker/i)
})

test('filterChannelWorkerDisplayLogs: hides duplicate merge summary and internal modify rows', () => {
  const rows = filterChannelWorkerDisplayLogs([
    {
      id: '1',
      created_at: '2026-06-12T15:08:45.000Z',
      action: 'merge_routed_modify_only',
      status: 'success',
      signal_id: 'edit-1',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'anchor-1', openLegs: 19, modified: 19 },
      response_payload: null,
      error_message: null,
    },
    {
      id: '2',
      created_at: '2026-06-12T15:08:45.000Z',
      action: 'merge_modify_summary',
      status: 'success',
      signal_id: 'edit-1',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'anchor-1', openLegs: 19, modified: 19, symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: { parsed_data: { action: 'buy', symbol: 'XAUUSD' } },
    },
    {
      id: '3',
      created_at: '2026-06-12T15:08:44.500Z',
      action: 'merge_anchor_selected',
      status: 'success',
      signal_id: 'edit-1',
      broker_account_id: 'broker-1',
      request_payload: { anchor_signal_id: 'anchor-1', symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
    },
    {
      id: '4',
      created_at: '2026-06-12T15:08:43.000Z',
      action: 'merge_modify_summary',
      status: 'success',
      signal_id: 'edit-2',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'anchor-1', openLegs: 18, modified: 18, symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: { parsed_data: { action: 'buy', symbol: 'XAUUSD' } },
    },
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, '2')
  assert.equal(
    channelWorkerLogMessage(rows[0]!, channelWorkerEn, { 'ch-1': 'Test Signal Channel' }),
    'Updated stop loss and take profit on 19 open XAUUSD legs (no new trades opened).',
  )
})

test('channelWorkerLogMessage: close worse entries success', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'mgmt_close_worse_entries',
      status: 'success',
      request_payload: { mode: 'instruction_immediate_only', symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        parsed_data: { action: 'close_worse_entries', symbol: 'XAUUSD' },
        status: 'executed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Test Signal Channel' },
  )
  assert.match(message ?? '', /instant.*XAUUSD/i)
})

test('channelWorkerLogMessage: hides internal range rebalance leg modify failures', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'basket_leg_modify',
      status: 'failed',
      request_payload: {
        internal_rebalance: true,
        broker_symbol: 'XAUUSD',
        target_tp: 4345,
      },
      response_payload: null,
      error_message: 'Order rejected',
      signals: {
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
      },
    },
    channelWorkerEn,
  )
  assert.equal(message, null)
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

test('channelWorkerLogMessage: hides unlinked channel dispatch skips', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'dispatch_skipped',
      status: 'skipped',
      request_payload: { skip_reason: 'no_broker_channel_match', channel_id: 'ch-1' },
      response_payload: null,
      error_message: 'no_broker_channel_match',
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'no_broker_channel_match',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: hides unlinked channel mgmt-style skipped remap', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'mgmt_modify',
      status: 'success',
      request_payload: { symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'modify', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'no_broker_channel_match',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.equal(message, null)
})
