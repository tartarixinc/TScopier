import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_CHANNEL_KEYWORDS,
  extractTpLevels,
  parseChannelMessageSync,
  parseModificationDeterministic,
} from './parseSignal'

function parse(message: string) {
  return parseChannelMessageSync(message, DEFAULT_CHANNEL_KEYWORDS, null).parsed
}

// ---------------------------------------------------------------------------
// Comma-separated TP tiers on one label (found 2026-10-23 offline matrix).
// ---------------------------------------------------------------------------

test('TP: comma list reads every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTP: 4010, 4020, 4030')
  assert.equal(parsed.action, 'buy')
  assert.equal(parsed.sl, 3990)
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('Take Profit: comma list reads every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTake Profit: 4010, 4020, 4030')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('comma list without spaces reads every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTP: 4010,4020,4030')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('a single thousands-formatted price is not split into tiers', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTP: 4,050')
  assert.deepEqual(parsed.tp, [4050])
})

test('decimal tiers split on commas', () => {
  const parsed = parse('BUY EURUSD NOW\nSL 1.1150\nTP: 1.1180, 1.1200')
  assert.deepEqual(parsed.tp, [1.118, 1.12])
})

// ---------------------------------------------------------------------------
// The plural "TPs" label (raw extraction previously returned nothing; the
// prices were only recovered later by inference, which dropped the first one).
// ---------------------------------------------------------------------------

test('TPs: comma list reads every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTPs: 4010, 4020, 4030')
  assert.equal(parsed.action, 'buy')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('TPs: slash list reads every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTPs: 4010 / 4020 / 4030')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('TPs without a separator after the colon still reads the list', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTPs: 4010 4020 4030')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('extractTpLevels itself accepts the plural label', () => {
  assert.deepEqual(extractTpLevels('TPs: 4010, 4020, 4030').values, [4010, 4020, 4030])
})

// ---------------------------------------------------------------------------
// "= separated" parameters on an entry must stay an entry.
// `=` was read as an adjust-command marker, so "BUY … SL=3990 TP1=4010"
// became a modification even though the same message with ":" or a space
// parses as an entry.
// ---------------------------------------------------------------------------

test('entry with = separated SL/TP and a side parses as an entry', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL=3990\nTP1=4010\nTP2=4020')
  assert.equal(parsed.action, 'buy')
  assert.equal(parsed.sl, 3990)
  assert.deepEqual(parsed.tp, [4010, 4020])
})

test('entry with a single = separated TP parses as an entry', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL=3990\nTP=4010')
  assert.equal(parsed.action, 'buy')
  assert.equal(parsed.sl, 3990)
  assert.deepEqual(parsed.tp, [4010])
})

test('a sideless = parameter post still modifies', () => {
  const parsed = parse('SL=3990\nTP1=4010\nTP2=4020')
  assert.equal(parsed.action, 'modify')
  assert.equal(parsed.sl, 3990)
  assert.deepEqual(parsed.tp, [4010, 4020])
})

test('verb-based management stays a modification even with a side present', () => {
  assert.equal(parse('BUY NOW SET SL TO 4005').action, 'modify')
  assert.equal(parse('SET SL TO 4005').action, 'modify')
})

// ---------------------------------------------------------------------------
// Existing behaviour that must not move.
// ---------------------------------------------------------------------------

test('slash-separated tiers still read every tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nSL 3990\nTP: 4010 / 4020 / 4030')
  assert.deepEqual(parsed.tp, [4010, 4020, 4030])
})

test('numbered tiers keep working', () => {
  assert.deepEqual(parse('BUY XAUUSD NOW\nSL 3990\nTP1 4040').tp, [4040])
  assert.deepEqual(parse('BUY XAUUSD NOW\nSL: 3990\nTP1: 4040').tp, [4040])
})

test('sell entry with a comma ladder keeps descending order', () => {
  const parsed = parse('SELL XAUUSD NOW\nSL 4045\nTP: 4000, 3990, 3980')
  assert.equal(parsed.action, 'sell')
  assert.deepEqual(parsed.tp, [4000, 3990, 3980])
})

test('close commands are unaffected', () => {
  assert.equal(parse('CLOSE HALF').action, 'partial_profit')
  assert.equal(parse('CLOSE TP1').action, 'partial_profit')
})

test('sideless parameter posts keep their follow-up meaning', () => {
  const parsed = parse('TPs: 4010, 4020')
  assert.equal(parsed.action, 'modify')
  assert.deepEqual(parsed.tp, [4010, 4020])
})

// ---------------------------------------------------------------------------
// Coverage gaps found by review: trained labels, newline safety, pips suffix.
// ---------------------------------------------------------------------------

test('trained extra labels read a comma ladder too', () => {
  assert.deepEqual(extractTpLevels('SET TP: 4010, 4020', ['SET TP']).values, [4010, 4020])
})

test('a newline is not a tier separator (the stop below is never swallowed)', () => {
  const result = extractTpLevels('TP: 4010\nSL 3990')
  assert.deepEqual(result.values, [4010])
})

test('a pips suffix marks the ladder as pips', () => {
  const result = extractTpLevels('TP: 4010, 4020 pips')
  assert.deepEqual(result.values, [4010, 4020])
  assert.equal(result.explicitPips, true)
})

// ---------------------------------------------------------------------------
// Review findings: ReDoS, combined SL/TP label, order-id bound, gate scope.
// ---------------------------------------------------------------------------

test('a crafted separator run cannot backtrack (ReDoS pin)', () => {
  const message = `TP: 4010${' ,'.repeat(24)}`
  const startedAt = Date.now()
  const values = extractTpLevels(message).values
  const elapsedMs = Date.now() - startedAt
  assert.deepEqual(values, [4010])
  assert.ok(elapsedMs < 2500, `list collector took ${elapsedMs}ms — backtracking regression`)
})

test('the TP half of a combined SL/TP label never becomes TP1', () => {
  // The stop is the single price under the combined label; the ladder above
  // it comes back through price inference, exactly as before this change.
  assert.deepEqual(extractTpLevels('SL/TP: 4010 4020').values, [])
  const parsed = parse('BUY XAUUSD NOW\nSL/TP: 4010 4020')
  assert.equal(parsed.action, 'buy')
  assert.equal(parsed.sl, 4010)
  assert.deepEqual(parsed.tp, [4020])
})

test('an order id on the same line does not ride into the ladder', () => {
  assert.deepEqual(extractTpLevels('TP: 4010 123456789').values, [4010])
})

test('a trailing number on the TP line is read as a tier', () => {
  const parsed = parse('BUY XAUUSD NOW\nTP: 4010 4020 3990\nSL 3990')
  assert.deepEqual(parsed.tp, [4010, 4020, 3990])
})

test('thousands-formatted tiers merge back into full prices', () => {
  assert.deepEqual(extractTpLevels('TP: 4,050, 4,060, 4,070').values, [4050, 4060, 4070])
})

test('a side without a symbol keeps its modify meaning under =', () => {
  const parsed = parse('BUY SL=3990\nTP=4010')
  assert.equal(parsed.action, 'modify')
  assert.equal(parsed.sl, 3990)
  assert.deepEqual(parsed.tp, [4010])
})

test('a message naming both sides stays a modification', () => {
  const parsed = parse('BUY or SELL XAUUSD SL=3990 TP=4010')
  assert.equal(parsed.action, 'modify')
})

test('a spaced two-tier pair is never merged into a thousands number', () => {
  // `4,050` (bare comma) is thousands; `50, 100` (comma + space) is two tiers.
  assert.deepEqual(extractTpLevels('TP: 50, 100').values, [50])
  assert.deepEqual(extractTpLevels('TP: 95, 100').values, [95])
  assert.deepEqual(extractTpLevels('TP: 4,050').values, [4050])
})

test('the management-only path keeps side+parameter messages as modifications', () => {
  // No entry parsers exist there, so the sync-chain handoff gate must not fire:
  // this message used to return a deterministic `modify` and must not turn
  // into a skip (which would drop it when AI modification parsing is off).
  const result = parseModificationDeterministic(
    'SELL EURUSD TP to 1.1100',
    DEFAULT_CHANNEL_KEYWORDS,
    null,
  )
  assert.equal(result.status, 'parsed')
  assert.equal(result.parsed.action, 'modify')
})

test('the full sync chain routes the same message through the entry parsers', () => {
  const result = parseChannelMessageSync(
    'SELL EURUSD TP to 1.1100',
    DEFAULT_CHANNEL_KEYWORDS,
    null,
  )
  assert.equal(result.parsed.action, 'sell')
  assert.deepEqual(result.parsed.tp, [1.11])
})
