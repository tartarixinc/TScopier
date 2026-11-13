import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { en } from '../i18n/locales/en'
import {
  copierProcessToastFingerprint,
  copierProcessToastFromLog,
  mergeCopierProcessToastSeen,
  shouldAnnounceCopierProcessToast,
} from './copierProcessToast'
import type { TradeActivityLogRow } from './tradeActivities'

const baseRow: TradeActivityLogRow = {
  id: 'log-1',
  created_at: '2026-11-13T10:00:00.000Z',
  action: 'order_send',
  status: 'success',
  request_payload: { symbol: 'XAUUSD', channel_name: 'Gold VIP' },
  response_payload: { ticket: 123 },
  error_message: null,
  signal_id: 'sig-1',
  broker_account_id: null,
  signals: {
    channel_id: 'ch-1',
    parsed_data: { action: 'buy', symbol: 'XAUUSD' },
    raw_message: 'Gold buy now',
    status: 'executed',
    skip_reason: null,
  },
}

test('copier process toast describes a successful order', () => {
  const toast = copierProcessToastFromLog(
    baseRow,
    en.channelWorker,
    en.management,
    { 'ch-1': 'Gold VIP' },
  )
  assert.ok(toast)
  assert.equal(toast?.status, 'successful')
  assert.equal(toast?.title, en.management.kindOrder)
  assert.match(toast?.detail ?? '', /./)
})

test('copier process toast ignores internal hidden actions', () => {
  const toast = copierProcessToastFromLog(
    { ...baseRow, action: 'basket_reconcile_tick', status: 'success' },
    en.channelWorker,
    en.management,
    {},
  )
  assert.equal(toast, null)
})

test('shouldAnnounceCopierProcessToast skips duplicates and hidden actions', () => {
  const seen = new Map<string, string>()
  assert.equal(shouldAnnounceCopierProcessToast(seen, baseRow), 'show')
  assert.equal(shouldAnnounceCopierProcessToast(seen, baseRow), 'skip')
  assert.equal(
    shouldAnnounceCopierProcessToast(seen, {
      id: 'log-2',
      action: 'basket_reconcile_tick',
      status: 'success',
    }),
    'skip',
  )
})

test('mergeCopierProcessToastSeen seeds fingerprints', () => {
  const seen = new Map<string, string>()
  mergeCopierProcessToastSeen(seen, [baseRow])
  assert.equal(seen.get('log-1'), copierProcessToastFingerprint(baseRow))
})
