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

test('channelWorkerLogMessage: signal_range_entry_no_price shows waiting message', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'signal_range_entry_no_price',
      status: 'skipped',
      request_payload: { direction: 'buy', symbol: 'XAUUSD' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'skipped',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'GTMO VIP' },
  )
  assert.match(String(message), /Buy pending/i)
  assert.match(String(message), /Waiting for price range/i)
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

test('filterChannelWorkerDisplayLogs: keeps one auto_be per signal/broker within 30s', () => {
  const rows = filterChannelWorkerDisplayLogs([
    {
      id: 'be-new',
      created_at: '2026-06-12T15:08:45.000Z',
      action: 'auto_be',
      status: 'failed',
      signal_id: 'sig-1',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'sig-1' },
      response_payload: null,
      error_message: 'not connected',
    },
    {
      id: 'be-old',
      created_at: '2026-06-12T15:08:44.600Z',
      action: 'auto_be',
      status: 'failed',
      signal_id: 'sig-1',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'sig-1' },
      response_payload: null,
      error_message: 'not connected',
    },
    {
      id: 'be-other',
      created_at: '2026-06-12T15:08:44.000Z',
      action: 'auto_be',
      status: 'failed',
      signal_id: 'sig-2',
      broker_account_id: 'broker-1',
      request_payload: { parent_signal_id: 'sig-2' },
      response_payload: null,
      error_message: 'not connected',
    },
  ])
  assert.deepEqual(rows.map(r => r.id), ['be-new', 'be-other'])
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

test('channelWorkerLogMessage: hides internal rebalance failures on modify signals', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'basket_leg_modify',
      status: 'failed',
      request_payload: {
        internal_rebalance: true,
        broker_symbol: 'XAUUSD',
        target_sl: 4125,
        target_tp: 4116,
      },
      response_payload: null,
      error_message: 'Order rejected',
      signals: {
        parsed_data: { action: 'modify', symbol: 'XAUUSD', sl: 4125, tp: [4116, 4114, 4110] },
      },
    },
    channelWorkerEn,
    { 'ch-1': 'SIGNALS 2' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: hides internal rebalance when flag is string true', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'basket_leg_modify',
      status: 'failed',
      request_payload: {
        internal_rebalance: 'true',
        broker_symbol: 'XAUUSD',
      },
      response_payload: null,
      error_message: 'Order rejected',
      signals: {
        parsed_data: { action: 'modify', symbol: 'XAUUSD' },
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

test('channelWorkerLogMessage: HTTP 503 shows bridge unavailable guidance', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'order_send',
      status: 'failed',
      request_payload: { symbol: 'XAUUSDm', operation: 'Buy' },
      response_payload: null,
      error_message: 'HTTP 503',
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'failed',
        skip_reason: 'HTTP 503',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message?.includes('Broker bridge temporarily unavailable'))
})

test('channelWorkerLogMessage: HTTP 500 with symbol shows mapping guidance', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'order_send',
      status: 'failed',
      request_payload: { symbol: 'XAUUSD', trade_symbol: 'XAUUSD', operation: 'Sell' },
      response_payload: null,
      error_message: 'HTTP 500',
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        status: 'failed',
        skip_reason: 'HTTP 500',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message, 'expected a user-facing message')
  assert.ok(!message!.includes('HTTP 500'), `still shows raw HTTP 500: ${message}`)
  assert.ok(
    message!.includes('GOLD#') || message!.includes('symbol mapping') || message!.includes('custom symbol') || message!.includes('XAUUSD'),
    `expected broker symbol guidance, got: ${message}`,
  )
})

test('channelWorkerLogMessage: Symbol not found uses mapping guidance', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'order_send',
      status: 'failed',
      request_payload: { symbol: 'XAUUSD', operation: 'Sell' },
      response_payload: null,
      error_message: 'Symbol not found: XAUUSD',
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        status: 'failed',
        skip_reason: 'Symbol not found: XAUUSD',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message?.includes('XAUUSD'))
  assert.ok(message?.includes('Broker symbol not found') || message?.includes('symbol mapping') || message?.includes('custom symbol'))
})

test('channelWorkerLogMessage: structured missing SL reason uses central friendly copy', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'dispatch_skipped',
      status: 'skipped',
      request_payload: {
        skip_reason: 'SIGNAL_MISSING_REQUIRED_SL',
        reason_code: 'SIGNAL_MISSING_REQUIRED_SL',
        trade_failure: {
          reasonCode: 'SIGNAL_MISSING_REQUIRED_SL',
          category: 'signal',
          title: 'SL not given — set predefined SL pips in broker configuration',
          explanation: 'The signal did not include a usable Stop Loss (often reserved for premium/VIP subscribers). Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.',
          recommendedAction: 'Open Account Configuration for this broker, turn on Override signal SL, and set Stop loss (pips from entry).',
          retryable: false,
          userActionRequired: true,
          safeContext: { missingField: 'stop_loss', withheldByProvider: true },
        },
      },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'SIGNAL_MISSING_REQUIRED_SL',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message)
  assert.match(message!, /SL not given/i)
  assert.match(message!, /predefined SL pips/i)
  assert.doesNotMatch(message!, /SIGNAL_MISSING_REQUIRED_SL/)
})

test('channelWorkerLogMessage: TP-without-SL skip tells user to set predefined SL pips', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'dispatch_skipped',
      status: 'skipped',
      request_payload: {
        skip_reason: 'entry_tp_without_sl',
        reason_code: 'entry_tp_without_sl',
      },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'entry_tp_without_sl',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message)
  assert.match(message!, /SL not given/i)
  assert.match(message!, /predefined SL pips/i)
  assert.doesNotMatch(message!, /entry tp without sl/i)
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

test('channelWorkerLogMessage: range basket TP rebalance skipped shows no-ladder reason', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'range_basket_tp_rebalance',
      status: 'skipped',
      request_payload: { skipped_reason: 'no_tp_ladder' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'executed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message)
  assert.match(message!, /Skipped XAUUSD take-profit rebalance/)
  assert.match(message!, /no tp ladder/)
})

test('channelWorkerLogMessage: range basket TP rebalance failed shows failure line', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'range_basket_tp_rebalance',
      status: 'failed',
      request_payload: {},
      response_payload: null,
      error_message: 'invalid stops',
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'executed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.ok(message)
  assert.match(message!, /Could not rebalance take profits on XAUUSD/i)
})

test('channelWorkerLogMessage: range basket TP rebalance success stays hidden', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'range_basket_tp_rebalance',
      status: 'success',
      request_payload: { modified: 3 },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        status: 'executed',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Gold Trader Mo' },
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: renders synthesized signal_skipped rows with localized reason', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'signal_skipped',
      status: 'skipped',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'ignore' },
        status: 'skipped',
        skip_reason: 'AI classified as non-actionable',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.ok(message)
  assert.match(message!, /Did not copy this signal/i)
  assert.match(message!, /no trade signal in this message/i)
  assert.doesNotMatch(message!, /AI classified as non-actionable/i)
})

test('channelWorkerLogMessage: signal_skipped modification reason uses skip-reason label', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'signal_skipped',
      status: 'skipped',
      request_payload: { skip_reason: 'modification_no_open_trade' },
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'modify', symbol: 'XAUUSD' },
        status: 'skipped',
        skip_reason: 'modification_no_open_trade',
      },
    },
    channelWorkerEn,
    { 'ch-1': 'Fredtrading' },
  )
  assert.ok(message)
  assert.match(message!, /no open trade to modify/i)
})

test('channelWorkerLogMessage: signal_skipped non-trade message stays hidden', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'signal_skipped',
      status: 'skipped',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: { action: 'ignore' },
        status: 'skipped',
        skip_reason: 'non_trade_message',
      },
    },
    channelWorkerEn,
    {},
  )
  assert.equal(message, null)
})

test('channelWorkerLogMessage: signal_skipped setup gap stays hidden', () => {
  const message = channelWorkerLogMessage(
    {
      action: 'signal_skipped',
      status: 'skipped',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signals: {
        channel_id: 'ch-1',
        parsed_data: null,
        status: 'skipped',
        skip_reason: 'no_broker_channel_match',
      },
    },
    channelWorkerEn,
    {},
  )
  assert.equal(message, null)
})

test('channelWorker skipReasons key parity across all locales', async () => {
  const { channelWorkerEn } = await import('../i18n/channelWorker/en')
  const { channelWorkerEs } = await import('../i18n/channelWorker/es')
  const { channelWorkerFr } = await import('../i18n/channelWorker/fr')
  const { channelWorkerAr } = await import('../i18n/channelWorker/ar')
  const { channelWorkerJa } = await import('../i18n/channelWorker/ja')
  const { channelWorkerNl } = await import('../i18n/channelWorker/nl')
  const { channelWorkerPl } = await import('../i18n/channelWorker/pl')
  const { channelWorkerRu } = await import('../i18n/channelWorker/ru')
  const { channelWorkerSv } = await import('../i18n/channelWorker/sv')

  const base = Object.keys(channelWorkerEn.skipReasons).sort()
  const locales: Record<string, { skipReasons: Record<string, string> }> = {
    es: channelWorkerEs,
    fr: channelWorkerFr,
    ar: channelWorkerAr,
    ja: channelWorkerJa,
    nl: channelWorkerNl,
    pl: channelWorkerPl,
    ru: channelWorkerRu,
    sv: channelWorkerSv,
  }
  for (const [name, bundle] of Object.entries(locales)) {
    assert.deepEqual(
      Object.keys(bundle.skipReasons).sort(),
      base,
      `${name} skipReasons keys must match en`,
    )
  }
})
