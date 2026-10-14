import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { en } from '../i18n/locales/en'
import {
  copierLogDestinationIcons,
  copierLogDestinationLabel,
  copierLogSourceIcon,
  copierLogSourceLabel,
  copierLogToastFromSignal,
  signalHistoryToastLabels,
} from './copierLogToast'
import type { BrokerAccount } from '../types/database'

const labels = signalHistoryToastLabels(en.signalHistoryPage)
const base = {
  id: 'sig-1',
  channel_id: 'ch-1',
  raw_message: 'Gold buy now',
  is_modification: false,
  parent_signal_id: null,
  created_at: '2026-10-13T10:00:00.000Z',
}

const route = {
  source: 'Telegram · Gold VIP',
  sourceIcon: '/Telegram.svg',
  destination: 'cTrader Demo',
  destinationIcons: ['/cTrader.png'],
}

test('copier log toast describes an executed buy', () => {
  const toast = copierLogToastFromSignal({
    ...base,
    status: 'executed',
    skip_reason: null,
    parsed_data: { action: 'buy', symbol: 'XAUUSD' },
  }, en.copierLogs, labels, route)
  assert.equal(toast?.title, 'Executed')
  assert.match(toast?.detail ?? '', /Buy/)
  assert.match(toast?.detail ?? '', /XAUUSD/)
  assert.equal(toast?.source, 'Telegram · Gold VIP')
  assert.equal(toast?.sourceIcon, '/Telegram.svg')
  assert.equal(toast?.destination, 'cTrader Demo')
  assert.deepEqual(toast?.destinationIcons, ['/cTrader.png'])
})

test('copier log toast uses the skip reason', () => {
  const toast = copierLogToastFromSignal({
    ...base,
    status: 'skipped',
    skip_reason: 'copier_paused',
    parsed_data: { action: 'buy', symbol: 'XAUUSD' },
  }, en.copierLogs, labels, route)
  assert.equal(toast?.title, 'Skipped')
  assert.equal(toast?.detail, 'Copier is paused')
  assert.equal(toast?.source, route.source)
  assert.equal(toast?.destination, route.destination)
})

test('copier log toast ignores commentary that never appears in the log', () => {
  const toast = copierLogToastFromSignal({
    ...base,
    status: 'skipped',
    skip_reason: 'non_trade_message',
    parsed_data: { action: 'ignore' },
  }, en.copierLogs, labels, route)
  assert.equal(toast, null)
})

test('copier log route names the channel and the linked broker', () => {
  assert.equal(copierLogSourceLabel({
    display_name: 'Gold VIP',
    source_kind: 'telegram',
  }, 'Unknown channel'), 'Telegram · Gold VIP')
  assert.equal(copierLogSourceIcon({ source_kind: 'telegram' }), '/Telegram.svg')
  assert.equal(copierLogSourceIcon(null), null)
  assert.equal(copierLogSourceLabel(null, 'Unknown channel'), 'Unknown channel')
  const brokers = [{
    id: 'b1',
    label: 'cTrader Demo',
    platform: 'cTrader',
    provider: 'ctrader',
    is_active: true,
    signal_channel_ids: ['CH-1'],
  }, {
    id: 'b2',
    label: 'Other account',
    platform: 'MT5',
    provider: 'ctrader',
    is_active: true,
    signal_channel_ids: ['ch-2'],
  }] as BrokerAccount[]
  assert.equal(copierLogDestinationLabel(brokers, 'ch-1'), 'cTrader Demo')
  assert.deepEqual(copierLogDestinationIcons(brokers, 'ch-1'), ['/cTrader.png'])
  assert.equal(copierLogDestinationLabel(brokers, null), '')
})
