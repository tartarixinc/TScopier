import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSignalsNeedingReconcile,
  shouldReconcileSignal,
  chunkTelegramMessageIds,
  signalLooksLikeTeaserBasket,
} from './signalTelegramReconcile'

describe('signalTelegramReconcile', () => {
  it('shouldReconcileSignal skips when edit_date unchanged and text matches', () => {
    assert.equal(
      shouldReconcileSignal(
        { raw_message: 'Gold buy', telegram_edit_date_seen: 100 },
        { text: 'Gold buy', editDateSec: 100 },
      ),
      false,
    )
  })

  it('shouldReconcileSignal detects text change', () => {
    assert.equal(
      shouldReconcileSignal(
        { raw_message: 'Gold buy', telegram_edit_date_seen: 100 },
        { text: 'Gold buy SL 2650', editDateSec: 101 },
      ),
      true,
    )
  })

  it('findSignalsNeedingReconcile returns mismatches only', () => {
    const signals = [{
      id: 's1',
      channel_id: 'c1',
      telegram_message_id: '42',
      raw_message: 'old',
      telegram_edit_date_seen: null,
      created_at: new Date().toISOString(),
    }]
    const snaps = new Map([['42', { text: 'new text', editDateSec: 5 }]])
    const out = findSignalsNeedingReconcile(signals, snaps)
    assert.equal(out.length, 1)
    assert.equal(out[0]?.rawMessage, 'new text')
  })

  it('chunkTelegramMessageIds deduplicates', () => {
    const chunks = chunkTelegramMessageIds(['1', '1', '2'])
    assert.equal(chunks.length, 1)
    assert.deepEqual(chunks[0], ['1', '2'])
  })

  it('signalLooksLikeTeaserBasket detects bare buy teaser', () => {
    assert.equal(signalLooksLikeTeaserBasket({ action: 'buy', sl: null, tp: [] }), true)
    assert.equal(signalLooksLikeTeaserBasket({ action: 'buy', sl: 4190, tp: [4210] }), false)
  })
})
