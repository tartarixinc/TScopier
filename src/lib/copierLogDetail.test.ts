import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  formatCopierSkipReasonDetail,
  formatCopierSkipReasonShort,
  getTradeFailureDisplayFromLog,
  isDispatchPushStartMarker,
  summarizeDispatchPushAttempt,
  summarizeExecutionLogRow,
} from './copierLogDetail'
import { resolveCopierSkipReasonKey } from './copierSkipReasonLabels'
import { en } from '../i18n/locales/en'
import { es } from '../i18n/locales/es'
import { pl } from '../i18n/locales/pl'

test('resolveCopierSkipReasonKey maps broker Invalid stops message', () => {
  assert.equal(resolveCopierSkipReasonKey('Invalid stops'), 'invalid_stops')
  assert.equal(resolveCopierSkipReasonKey('channel_max_risk_hit'), 'channel_max_risk_hit')
})

test('resolveCopierSkipReasonKey maps human-review free text', () => {
  assert.equal(
    resolveCopierSkipReasonKey('ai classified as uncertain; human review required'),
    'ai_classified_as_uncertain_human_review_required',
  )
})

test('formatCopierSkipReasonShort uses friendly label', () => {
  const label = formatCopierSkipReasonShort('channel_max_risk_hit', en.copierLogs)
  assert.equal(label, 'Daily risk limit reached')
})

test('formatCopierSkipReasonShort translates via locale skipReasons', () => {
  const esLabel = formatCopierSkipReasonShort('copier_paused', es.copierLogs)
  assert.match(esLabel, /pausa/i)
  const plLabel = formatCopierSkipReasonShort('entry_not_opened', pl.copierLogs)
  assert.match(plLabel, /pozycj/i)
  // Deep-merge keeps English keys that logs/pl did not override, while CW fills others.
  const plPaused = formatCopierSkipReasonShort('telegram_listener_not_live', pl.copierLogs)
  assert.match(plPaused, /Telegram/i)
  assert.notEqual(plPaused, 'telegram_listener_not_live')
})

test('formatCopierSkipReasonShort maps missing-SL skips to predefined SL hint', () => {
  const missing = formatCopierSkipReasonShort('SIGNAL_MISSING_REQUIRED_SL', en.copierLogs)
  const tpOnly = formatCopierSkipReasonShort('entry_tp_without_sl', en.copierLogs)
  assert.match(missing, /SL not given/)
  assert.match(missing, /predefined SL pips/)
  assert.equal(tpOnly, missing)
})

test('formatCopierSkipReasonDetail returns actionable text', () => {
  const detail = formatCopierSkipReasonDetail('invalid_stops', en.copierLogs)
  assert.match(detail ?? '', /broker rejected/i)
})

test('getTradeFailureDisplayFromLog reads structured reason payload', () => {
  const display = getTradeFailureDisplayFromLog({
    error_message: 'HTTP 500',
    request_payload: {
      reason_code: 'BROKER_SYMBOL_NOT_FOUND',
      symbol: 'XAUUSD',
    },
  })
  assert.equal(display?.reasonCode, 'BROKER_SYMBOL_NOT_FOUND')
  assert.match(display?.explanation ?? '', /GOLD\/XAUUSD/)
})

test('getTradeFailureDisplayFromLog keeps legacy broker messages readable', () => {
  const display = getTradeFailureDisplayFromLog({
    error_message: 'Symbol not found: XAUUSD',
    request_payload: null,
  })
  assert.equal(display?.reasonCode, 'BROKER_SYMBOL_NOT_FOUND')
})

test('isDispatchPushStartMarker detects synthetic pre-attempt success rows', () => {
  assert.equal(isDispatchPushStartMarker({
    action: 'dispatch_push_attempt',
    request_payload: { phase: 'start' },
  }), true)
  assert.equal(isDispatchPushStartMarker({
    action: 'dispatch_push_attempt',
    request_payload: { phase: 'attempt', attempt: 1 },
  }), false)
})

test('summarizeDispatchPushAttempt explains rate limit and 502 failures', () => {
  assert.match(
    summarizeDispatchPushAttempt({
      action: 'dispatch_push_attempt',
      status: 'failed',
      error_message: null,
      request_payload: { phase: 'attempt', attempt: 1, status_code: 429, detail: 'rate limited' },
      created_at: '2026-11-14T00:00:00Z',
    }),
    /rate-limited/i,
  )
  assert.match(
    summarizeDispatchPushAttempt({
      action: 'dispatch_push_attempt',
      status: 'failed',
      error_message: null,
      request_payload: {
        phase: 'attempt',
        attempt: 2,
        status_code: 502,
        detail: '{"message":"Application failed to respond"}',
      },
      created_at: '2026-11-14T00:00:00Z',
    }),
    /unreachable/i,
  )
  assert.match(
    summarizeExecutionLogRow({
      action: 'dispatch_push_attempt',
      status: 'success',
      error_message: null,
      request_payload: { phase: 'attempt', attempt: 1, ok: true },
      created_at: '2026-11-14T00:00:00Z',
    }, en.copierLogs),
    /succeeded/i,
  )
})
