import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { channelWorkerEn } from '../i18n/channelWorker/en'
import { en } from '../i18n/locales/en'
import {
  buildSkippedSignalActivities,
  mergeSkippedSignalActivities,
  shouldRefreshActivitiesOnRealtimePayload,
  tradeActivityLogsFingerprint,
  type DisplayableTradeActivity,
  type SkippedSignalRow,
} from './tradeActivities'

test('shouldRefreshActivitiesOnRealtimePayload: ignores hidden internal ticks', () => {
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'basket_reconcile_tick' }), false)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'queue_consume_ack' }), false)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'merge_routed_modify_only' }), false)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'news_pre_close' }), false)
})

test('shouldRefreshActivitiesOnRealtimePayload: refreshes visible copier activity', () => {
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'order_send' }), true)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'auto_be' }), true)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'mgmt_modify' }), true)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({ action: 'AUTO_BE' }), true)
})

test('shouldRefreshActivitiesOnRealtimePayload: refreshes when action is missing', () => {
  assert.equal(shouldRefreshActivitiesOnRealtimePayload({}), true)
  assert.equal(shouldRefreshActivitiesOnRealtimePayload(null), true)
})

test('tradeActivityLogsFingerprint: identical newest/count skips a React rewrite', () => {
  const a = [{ id: '1' }, { id: '2' }, { id: '3' }]
  const b = [{ id: '1' }, { id: '2' }, { id: '3' }]
  assert.equal(tradeActivityLogsFingerprint(a), tradeActivityLogsFingerprint(b))
})

test('tradeActivityLogsFingerprint: new row or count change is a different snapshot', () => {
  const prev = tradeActivityLogsFingerprint([{ id: '1' }, { id: '2' }])
  const newer = tradeActivityLogsFingerprint([{ id: '0' }, { id: '1' }, { id: '2' }])
  const swapped = tradeActivityLogsFingerprint([{ id: '9' }, { id: '2' }])
  assert.notEqual(prev, newer)
  assert.notEqual(prev, swapped)
  assert.equal(tradeActivityLogsFingerprint([]), '0')
})

const skippedFixture: SkippedSignalRow[] = [
  {
    id: 'sig-ai',
    created_at: '2026-09-25T10:00:00+00:00',
    channel_id: 'ch-1',
    parsed_data: { action: 'ignore' },
    skip_reason: 'AI classified as non-actionable',
    status: 'skipped',
  },
  {
    id: 'sig-mod',
    created_at: '2026-09-25T09:00:00+00:00',
    channel_id: 'ch-1',
    parsed_data: { action: 'modify', symbol: 'XAUUSD' },
    skip_reason: 'modification_no_open_trade',
    status: 'skipped',
  },
]

function logActivity(signalId: string, createdAt: string): DisplayableTradeActivity {
  return {
    row: {
      id: `log-${signalId}`,
      created_at: createdAt,
      action: 'order_send',
      status: 'skipped',
      request_payload: null,
      response_payload: null,
      error_message: null,
      signal_id: signalId,
      broker_account_id: null,
      signals: null,
    },
    message: 'order skipped',
    status: 'skipped',
    kind: en.management.kindOrder,
    symbol: null,
    channelName: null,
    retryEligible: false,
  }
}

test('buildSkippedSignalActivities: synthesizes rows for parse-level skips', () => {
  const out = buildSkippedSignalActivities(
    skippedFixture,
    [],
    channelWorkerEn,
    en.management,
    { 'ch-1': 'James VIP Signals' },
  )
  assert.equal(out.length, 2)

  const ai = out.find(a => a.row.id === 'signal:sig-ai')
  assert.ok(ai)
  assert.equal(ai!.status, 'skipped')
  assert.equal(ai!.kind, en.management.kindPipeline)
  assert.equal(ai!.retryEligible, false)
  assert.equal(ai!.channelName, 'James VIP Signals')
  assert.match(ai!.message, /Did not copy this signal/i)
  assert.match(ai!.message, /no trade signal in this message/i)

  const mod = out.find(a => a.row.id === 'signal:sig-mod')
  assert.ok(mod)
  assert.equal(mod!.kind, en.management.kindModify)
  assert.equal(mod!.symbol, 'XAUUSD')
  assert.match(mod!.message, /no open trade to modify/i)
})

test('buildSkippedSignalActivities: dedupes signals already shown via execution logs', () => {
  const out = buildSkippedSignalActivities(
    skippedFixture,
    [logActivity('sig-mod', '2026-09-25T09:00:00+00:00')],
    channelWorkerEn,
    en.management,
    {},
  )
  assert.equal(out.length, 1)
  assert.equal(out[0]!.row.id, 'signal:sig-ai')
})

test('buildSkippedSignalActivities: hides non-trade and setup-gap reasons', () => {
  const out = buildSkippedSignalActivities(
    [
      {
        id: 'sig-nt',
        created_at: '2026-09-25T10:00:00+00:00',
        parsed_data: { action: 'ignore' },
        skip_reason: 'non_trade_message',
        status: 'skipped',
      },
      {
        id: 'sig-nb',
        created_at: '2026-09-25T09:00:00+00:00',
        parsed_data: null,
        skip_reason: 'no_broker_channel_match',
        status: 'skipped',
      },
    ],
    [],
    channelWorkerEn,
    en.management,
    {},
  )
  assert.equal(out.length, 0)
})

test('mergeSkippedSignalActivities: merges parse skips into the log feed newest first', () => {
  const logs = [logActivity('sig-old', '2026-09-25T08:00:00+00:00')]
  const merged = mergeSkippedSignalActivities(
    logs,
    skippedFixture,
    channelWorkerEn,
    en.management,
    {},
  )
  assert.deepEqual(
    merged.map(a => a.row.id),
    ['signal:sig-ai', 'signal:sig-mod', 'log-sig-old'],
  )
})

test('mergeSkippedSignalActivities: returns log feed untouched when nothing to merge', () => {
  const logs = [logActivity('sig-old', '2026-09-25T08:00:00+00:00')]
  const merged = mergeSkippedSignalActivities(logs, [], channelWorkerEn, en.management, {})
  assert.equal(merged, logs)
})

test('buildSkippedSignalActivities: synthesizes when logs show the signal as success', () => {
  const successLog: DisplayableTradeActivity = {
    ...logActivity('sig-mod', '2026-09-25T09:05:00+00:00'),
    status: 'successful',
  }
  const out = buildSkippedSignalActivities(
    skippedFixture,
    [successLog],
    channelWorkerEn,
    en.management,
    {},
  )
  assert.deepEqual(out.map(a => a.row.id), ['signal:sig-ai', 'signal:sig-mod'])
})

test('buildSkippedSignalActivities: ignores rows whose status is not skipped', () => {
  const out = buildSkippedSignalActivities(
    [{ ...skippedFixture[0]!, status: 'parsed' }],
    [],
    channelWorkerEn,
    en.management,
    {},
  )
  assert.equal(out.length, 0)
})
