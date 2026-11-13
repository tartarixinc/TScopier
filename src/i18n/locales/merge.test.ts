import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { en } from './en'
import { mergeLocaleBundle } from './merge'
import type { Translations } from './types'

describe('mergeLocaleBundle copierLogs', () => {
  it('deep-merges skipReasons and keeps English keys not in the overlay', () => {
    const merged = mergeLocaleBundle(en, {
      copierLogs: {
        ...en.copierLogs,
        title: 'Dzienniki',
        skipReasons: {
          entry_not_opened: 'Broker nie otworzył pozycji',
        },
      },
      channelWorker: {
        ...en.channelWorker,
        skipReasons: {
          ...en.channelWorker.skipReasons,
          copier_paused: 'kopiator jest wstrzymany',
        },
      },
    } as Partial<Translations>)

    assert.equal(merged.copierLogs.title, 'Dzienniki')
    assert.equal(merged.copierLogs.skipReasons.entry_not_opened, 'Broker nie otworzył pozycji')
    assert.match(merged.copierLogs.skipReasons.copier_paused, /wstrzymany/i)
    assert.ok(merged.copierLogs.skipReasons.channel_max_risk_hit)
    assert.ok(merged.copierLogs.detailModal?.title)
    assert.equal(merged.copierLogs.closeReasons.stop_loss, en.copierLogs.closeReasons.stop_loss)
  })

  it('keeps localized detailModal from logs overlays', async () => {
    const { logsPl } = await import('./logs/pl')
    const { channelWorkerPl } = await import('../channelWorker/pl')
    const merged = mergeLocaleBundle(en, {
      ...logsPl,
      channelWorker: channelWorkerPl,
    })
    assert.equal(merged.copierLogs.detailModal?.title, 'Szczegóły sygnału')
    assert.equal(merged.copierLogs.detailModal?.viewDetails, 'Zobacz szczegóły')
  })
})
