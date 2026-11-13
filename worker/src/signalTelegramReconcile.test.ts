import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSignalsNeedingReconcile,
  revisionBlockedForManagement,
  telegramMessageText,
  findSignalsWithParsedDrift,
  normalizedSlTpTargets,
  parsedTargetsDrift,
  shouldReconcileSignal,
  chunkTelegramMessageIds,
  signalLooksLikeTeaserBasket,
} from './signalTelegramReconcile'

describe('signalTelegramReconcile', () => {
  it('telegramMessageText reads text, message, rawText and caption shapes', () => {
    assert.equal(telegramMessageText({ text: 'CLOSE TP2' }), 'CLOSE TP2')
    assert.equal(telegramMessageText({ message: 'CLOSE TP2' }), 'CLOSE TP2')
    assert.equal(telegramMessageText({ rawText: 'CLOSE TP2' }), 'CLOSE TP2')
    assert.equal(telegramMessageText({ caption: 'CLOSE TP2' }), 'CLOSE TP2')
    assert.equal(telegramMessageText(null), '')
    assert.equal(telegramMessageText({ text: '' }), '')
    // Empty text falls through to the populated field; first non-empty wins.
    assert.equal(telegramMessageText({ text: '', caption: 'CLOSE TP2' }), 'CLOSE TP2')
    assert.equal(telegramMessageText({ text: 'A', caption: 'B' }), 'A')
  })

  it('revisionBlockedForManagement blocks point-in-time management actions only', () => {
    // Management commands must never be re-parsed by the reconcile sweep:
    // a revision drops close_tp_index and widens the instruction (2026-11-13).
    assert.equal(revisionBlockedForManagement({ action: 'close' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'partial_profit' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'breakeven' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'partial_breakeven' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'close_worse_entries' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'modify' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'delete_pendings' }), true)
    assert.equal(revisionBlockedForManagement({ action: 'CLOSE' }), true)
    assert.equal(revisionBlockedForManagement({ action: '  Close  ' }), true)
    // Entries keep the revision refresh (edited price/stops still update).
    assert.equal(revisionBlockedForManagement({ action: 'buy' }), false)
    assert.equal(revisionBlockedForManagement({ action: 'sell' }), false)
    assert.equal(revisionBlockedForManagement({ action: '' }), false)
    assert.equal(revisionBlockedForManagement(null), false)
  })

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

  it('shouldReconcileSignal rejects stale fetch with older edit_date even when text differs', () => {
    assert.equal(
      shouldReconcileSignal(
        { raw_message: 'Gold buy SL 2650', telegram_edit_date_seen: 101 },
        { text: 'Gold buy', editDateSec: 100 },
      ),
      false,
    )
  })

  it('shouldReconcileSignal accepts newer edit_date when text differs', () => {
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

  it('parsedTargetsDrift detects missing TP tier', () => {
    assert.equal(
      parsedTargetsDrift(
        { action: 'sell', sl: 4080, tp: [4060] },
        { action: 'sell', sl: 4080, tp: [4066, 4060] },
      ),
      true,
    )
    assert.equal(
      parsedTargetsDrift(
        { action: 'sell', sl: 4080, tp: [4066, 4060] },
        { action: 'sell', sl: 4080, tp: [4066, 4060] },
      ),
      false,
    )
  })

  it('findSignalsWithParsedDrift catches text match with wrong stored SL/TP', () => {
    const signals = [{
      id: 's1',
      channel_id: 'c1',
      telegram_message_id: '393',
      raw_message: 'Gold sell now \nTP. 4066\nTP. 4060\nSL: 4080',
      telegram_edit_date_seen: 100,
      created_at: new Date().toISOString(),
      parsed_data: { action: 'sell', sl: 4080, tp: [4060] },
    }]
    const snaps = new Map([['393', { text: signals[0]!.raw_message, editDateSec: 100 }]])
    const out = findSignalsWithParsedDrift(signals, snaps, new Set(), () => ({
      sl: 4080,
      tp: [4066, 4060],
    }))
    assert.equal(out.length, 1)
    assert.equal(out[0]?.signal.id, 's1')
  })
})
