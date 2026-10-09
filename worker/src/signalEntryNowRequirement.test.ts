import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { messageHasExplicitStopLabel, messageLabelsEntryAnchor, parsedMissesLabeledEntry } from './signalEntryNowRequirement'
describe('messageLabelsEntryAnchor', () => {
  it('detects labeled entry anchors', () => {
    const positives = [
      'ENTRY ZONE: 4358',
      'Entry Zone 4358',
      'ENTRY AREA: 4358',
      'ENTRY: 4358',
      'ENTRY PRICE: 4358',
      'ENTRY LEVEL 4358',
      'ENTRY at 4358',
      'ENTRY @ 4358',
      'BUY LIMIT 4358',
      'SELL LIMIT 4358',
      'BUY LIMIT ORDER 4358',
      'LIMIT PRICE 4256',
      'BUY AT 4358',
      'SELL AT 4358',
      'AREA: 4358',
      'AREA 4358',
      'ZONE: 4358',
      'BUY XAUUSD FROM 4358',
      'FROM 4358',
      '@4358',
      'Gold buy @ 4358',
      'PRICE: 4256',
      'Gold buy\nPRICE: 4256',
      'منطقة الدخول: 4358',
      'سعر الدخول 4358',
    ]
    for (const msg of positives) {
      assert.equal(messageLabelsEntryAnchor(msg), true, `expected true: ${msg}`)
    }
  })

  it('does not flag market entries or SL/TP-only labels', () => {
    const negatives = [
      'Gold buy now',
      'GOLD SELL AT MARKET, SL 4120 TP 4100',
      'Buy market now',
      'XAUUSD BUY 4358',
      'TP price: 4210',
      'Target price: 4358',
      'The price: 2000',
      'TP: 4210\nSL: 4190',
      'Gold buy now\nSL: 4190\nTP: 4210',
      // Prose / management text that must not be read as an entry label.
      'Trail SL from 4348',
      'Move SL to breakeven from 4350',
      'target 200 pips from 2640',
      'profit from 4358',
      'support area 4350',
      'good entry',
      'GOLD BUY NOW SL 2640 TP 2660, support area 4350',
      // "@" used as the SL/TP separator is not an entry anchor.
      'TP @ 4256',
      'SL @ 4276',
      'GOLD SELL NOW\nTP1 @ 4256\nSL @ 4276',
      'TP 1 @ 4256',
      'TP(1) @ 4256',
      'Take Profit 1 @ 4256',
      'TP1: @ 4256',
      'TP#1 @ 4256',
    ]
    for (const msg of negatives) {
      assert.equal(messageLabelsEntryAnchor(msg), false, `expected false: ${msg}`)
    }
  })
})

describe('parsedMissesLabeledEntry', () => {
  it('flags a labeled entry the parse did not read', () => {
    assert.equal(
      parsedMissesLabeledEntry({ entry_price: null }, 'BUY XAUUSD\nAREA: 4358\nSL: 4348'),
      true,
    )
  })

  it('does not flag when the parse has an anchor', () => {
    assert.equal(
      parsedMissesLabeledEntry({ entry_price: 4358 }, 'BUY XAUUSD\nENTRY ZONE: 4358'),
      false,
    )
  })

  it('does not flag a genuine market entry', () => {
    assert.equal(
      parsedMissesLabeledEntry({ entry_price: null }, 'Gold buy now\nSL: 4190\nTP: 4210'),
      false,
    )
  })
})
describe('messageHasExplicitStopLabel', () => {
  it('detects stop labels in every observed shape', () => {
    const positives = [
      'GOLD SELL NOW 4095\nSL.TP 4105',
      'GOLD SELL NOW 4095\nSL \u27a1\ufe0f(4110)',
      'GOLD BUY NOW 4120\nSL (4080)',
      'GOLD BUY NOW 4120\nSL 4098',
      'GOLD BUY NOW 4120\nSTOP LOSS: 4098',
      'GOLD BUY NOW 4120\nStop Loss to 4098',
      'GOLD BUY NOW 4120\nSTOP LOSS (SL): 4098',
      '\u063a\u0631\u0627\u0626 \u0634\u0631\u0627\u0621 \u0627\u0644\u0622\u0646 \u0648\u0642\u0641 \u0627\u0644\u062e\u0633\u0627\u0631\u0629 4105',
    ]
    for (const msg of positives) {
      assert.equal(messageHasExplicitStopLabel(msg), true, `expected true: ${msg}`)
    }
  })
  it('does not flag take-profit-only or prose messages', () => {
    const negatives = [
      'GOLD BUY 4090 To 4110 \ud83d\udd25\u2705',
      'GOLD SELL NOW 4095\nTP1 4090\nTP2 4085',
      '',
      'Thanks for the update',
    ]
    for (const msg of negatives) {
      assert.equal(messageHasExplicitStopLabel(msg), false, `expected false: ${msg}`)
    }
  })
})
