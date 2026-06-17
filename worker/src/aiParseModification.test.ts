import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseModificationDeterministic, parseChannelMessageSync, DEFAULT_CHANNEL_KEYWORDS } from './parseSignal'
import { coerceMgmtSlTpFollowUpAction, shouldSkipConditionalCloseForAi } from './aiParseModification'

function mapActionToIntent(action: string) {
  const a = String(action ?? '').toLowerCase()
  if (a === 'modify') return 'modify'
  if (a === 'close') return 'close'
  if (a === 'breakeven') return 'breakeven'
  if (a === 'partial_profit') return 'partial_profit'
  if (a === 'buy' || a === 'sell') return 'parameter_refresh'
  return 'ignore'
}

describe('parseModificationDeterministic', () => {
  it('parses move SL management with high confidence', () => {
    const result = parseModificationDeterministic(
      'Move SL to 2650',
      DEFAULT_CHANNEL_KEYWORDS,
      null,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.sl, 2650)
    assert.ok((result.parsed.confidence ?? 0) >= 0.9)
  })

  it('parses adjust SL to price with high confidence', () => {
    const result = parseModificationDeterministic(
      'Adjust SL to 4505',
      DEFAULT_CHANNEL_KEYWORDS,
      null,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.sl, 4505)
    assert.ok((result.parsed.confidence ?? 0) >= 0.9)
  })

  it('parses set SL price with high confidence', () => {
    const result = parseModificationDeterministic(
      'Set SL 2650',
      DEFAULT_CHANNEL_KEYWORDS,
      null,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.sl, 2650)
    assert.ok((result.parsed.confidence ?? 0) >= 0.9)
  })

  it('parses close worse entries with high confidence', () => {
    const result = parseModificationDeterministic(
      'Close worse entries',
      DEFAULT_CHANNEL_KEYWORDS,
      null,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'close_worse_entries')
    assert.ok((result.parsed.confidence ?? 0) >= 0.9)
  })

  it('skips bare chatter without management keywords', () => {
    const result = parseModificationDeterministic(
      'Nice trade everyone',
      DEFAULT_CHANNEL_KEYWORDS,
      null,
    )
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })
})

describe('ai modification intent mapping', () => {
  it('maps buy with SL to parameter_refresh intent', () => {
    assert.equal(mapActionToIntent('buy'), 'parameter_refresh')
    assert.equal(mapActionToIntent('modify'), 'modify')
  })

  it('coerces buy + SL-only AI output to modify for basket mgmt path', () => {
    const coerced = coerceMgmtSlTpFollowUpAction({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 4505,
      tp: null,
      lot_size: null,
      raw_instruction: 'Adjust SL to 4505',
    }, 'parameter_refresh')
    assert.equal(coerced.action, 'modify')
    assert.equal(coerced.sl, 4505)
  })

  it('keeps buy + priced entry as entry (not modify)', () => {
    const kept = coerceMgmtSlTpFollowUpAction({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 2650,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 2640,
      tp: [2670],
      lot_size: null,
      raw_instruction: 'BUY XAUUSD 2650 SL 2640 TP 2670',
    }, 'parameter_refresh')
    assert.equal(kept.action, 'buy')
  })

  it('marks conditional close wording as non-actionable', () => {
    const shouldSkip = shouldSkipConditionalCloseForAi({
      action: 'close',
      symbol: null,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [],
      lot_size: null,
      raw_instruction: 'If you are happy, close now',
    }, 'If you are happy, close now')
    assert.equal(shouldSkip, true)
  })
})

describe('revision deterministic entry re-parse', () => {
  it('parses SIGNALS PRO edited entry with SL/TP without AI', () => {
    const msg = `Gold buy now 4207 - 4204

SL: 4200

TP: 4215
TP: 4220
TP: 4225
TP: 4240
TP: open`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.sl, 4200)
    assert.deepEqual(result.parsed.tp, [4215, 4220, 4225, 4240])
  })
})
