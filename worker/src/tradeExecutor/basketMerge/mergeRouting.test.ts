import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import type { ParsedSignal } from '../types'
import type { BasketMergeLinkContext } from '../../signalMergeLink'
import {
  anchorParsedIsCompleteEntry,
  isUnlinkedCompleteEntryMerge,
  revisionRefreshWithoutOpenBasketOutcome,
} from './mergeRouting'

function link(overrides: Partial<BasketMergeLinkContext> = {}): BasketMergeLinkContext {
  return {
    replyOk: false,
    withinWindow: true,
    threadLinksAnchor: false,
    implicitBundleWithinTightWindow: true,
    implicitSameChannelBundle: true,
    parameterRefreshSameChannel: true,
    sameSignalRefresh: false,
    sameChannel: true,
    isLinked: true,
    dtMs: 60_000,
    parentLinksAnchor: false,
    ...overrides,
  }
}

const stefanSignal4: ParsedSignal = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: null,
  entry_zone_low: 4436,
  entry_zone_high: 4441,
  sl: 4531,
  tp: [4446, 4451, 4456],
  lot_size: null,
  raw_instruction: 'GOLD BUY SETUP\n\nGold Buy Zone 4441 - 4436\n\nSL : 4531\n\nTP1 : 4446\nTP2 : 4451\nTP3 : 4456\nTP4 : Hold',
}

test('revision refresh without open basket is handled and does not reopen entry', () => {
  assert.deepEqual(
    revisionRefreshWithoutOpenBasketOutcome(true),
    { handled: true, success: false },
  )
})

test('non-revision parameter follow-up without open basket may fall through', () => {
  assert.deepEqual(
    revisionRefreshWithoutOpenBasketOutcome(false),
    { handled: false },
  )
})

test('unlinked complete same-side GOLD setup is not eligible for merge into existing basket', () => {
  assert.equal(isUnlinkedCompleteEntryMerge(stefanSignal4, link()), true)
})

test('unlinked complete GOLD setup stays entry-shaped when parsed zone fields are missing', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    entry_zone_low: null,
    entry_zone_high: null,
    raw_instruction: 'GOLD BUY SETUP\nGold Buy Zone 4317 - 4314\nSL : 4308\nTP1 : 4321\nTP2 : 4325\nTP3 : 4329\nTP4 : Hold',
  }, link()), true)
})

test('unlinked complete GOLD setup stays entry-shaped when stored intent holds the zone', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    entry_zone_low: null,
    entry_zone_high: null,
    raw_instruction: '',
    _intent: {
      kind: 'entry',
      side: 'BUY',
      symbol: 'XAUUSD',
      entry: [4314, 4317],
      sl: 4308,
      tp: [4321, 4325, 4329],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: { market_now: false },
      confidence: 0.86,
    },
  } as ParsedSignal, link()), true)
})

test('explicit reply complete entry may still use merge linking', () => {
  assert.equal(isUnlinkedCompleteEntryMerge(stefanSignal4, link({
    replyOk: true,
  })), false)
})

test('same-signal revision with complete stops may still refresh its own basket', () => {
  assert.equal(isUnlinkedCompleteEntryMerge(stefanSignal4, link({
    sameSignalRefresh: true,
  })), false)
})

test('market-now teaser completion remains eligible for merge handling', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    raw_instruction: 'Gold buy now 4441 - 4436\nSL 4531\nTP 4446',
  }, link()), false)
})

test('market-now entry into a complete-entry anchor is not merge-eligible', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    raw_instruction: 'Gold buy now 4441 - 4436\nSL 4531\nTP 4446',
  }, link(), { anchorIsCompleteEntry: true }), true)
})

test('market-now entry into a teaser anchor stays merge-eligible', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    raw_instruction: 'Gold buy now 4441 - 4436\nSL 4531\nTP 4446',
  }, link(), { anchorIsCompleteEntry: false }), false)
})

test('entry-shaped follow-up with no stops into a complete-entry anchor is not merge-eligible', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    action: 'buy',
    symbol: 'XAUUSD',
    entry_price: 4175.41,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: null,
    tp: [],
    lot_size: null,
    raw_instruction: 'Order : Buy\nEntry Price : 4175.41',
  }, link(), { anchorIsCompleteEntry: true }), true)
})

test('entry-shaped follow-up with no stops into a teaser anchor is not merge-eligible', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    action: 'sell',
    symbol: 'XAUUSD',
    entry_price: 4165.79,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: null,
    tp: [],
    lot_size: null,
    raw_instruction: 'Order : Sell\nEntry Price : 4165.79\nOrder Type : Instant\nStop Loss : 0.00',
  }, link(), { anchorIsCompleteEntry: false }), true)
})

test('anchorParsedIsCompleteEntry classifies anchor shapes', () => {
  // Complete entry: explicit entry price.
  assert.equal(anchorParsedIsCompleteEntry({
    action: 'buy', symbol: 'XAUUSD', entry_price: 4176.16,
    entry_zone_low: null, entry_zone_high: null, sl: null, tp: [], lot_size: null,
  } as ParsedSignal), true)
  // Complete entry: stops but no price (market entry with stops).
  assert.equal(anchorParsedIsCompleteEntry({
    action: 'buy', symbol: 'XAUUSD', entry_price: null,
    entry_zone_low: null, entry_zone_high: null, sl: 4150, tp: [4165], lot_size: null,
  } as ParsedSignal), true)
  // Teaser: direction only, no price and no stops.
  assert.equal(anchorParsedIsCompleteEntry({
    action: 'buy', symbol: 'XAUUSD', entry_price: null,
    entry_zone_low: null, entry_zone_high: null, sl: null, tp: [], lot_size: null,
  } as ParsedSignal), false)
  // Unknown shapes are not classified.
  assert.equal(anchorParsedIsCompleteEntry({ action: 'ignore' } as ParsedSignal), undefined)
  assert.equal(anchorParsedIsCompleteEntry({} as ParsedSignal), undefined)
  assert.equal(anchorParsedIsCompleteEntry(null), undefined)
})

test('reply-linked follow-up into a complete-entry anchor stays merge-eligible', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    ...stefanSignal4,
    raw_instruction: 'Gold buy now 4441 - 4436\nSL 4531\nTP 4446',
  }, link({ replyOk: true }), { anchorIsCompleteEntry: true }), false)
})

test('SL-only management refresh remains eligible for merge handling', () => {
  assert.equal(isUnlinkedCompleteEntryMerge({
    action: 'buy',
    symbol: 'XAUUSD',
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: 4531,
    tp: [],
    lot_size: null,
    raw_instruction: 'SL : 4531',
  }, link()), false)
})
