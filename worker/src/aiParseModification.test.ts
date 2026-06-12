import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseModificationDeterministic, DEFAULT_CHANNEL_KEYWORDS } from './parseSignal'

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
})
