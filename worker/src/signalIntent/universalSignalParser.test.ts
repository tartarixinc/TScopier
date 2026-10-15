import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { compareParseShadowDiff } from './shadowDiff'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from '../parseSignal'
import { tradeIntentToChannelParsedSignal } from './tradeIntentAdapter'
import { coerceTradeIntent } from './coerceTradeIntent'
import { PORTUGUESE_SCALP_SELL } from './fixtures/multilingualFixtures'
import { cerebrasKeyOrder, isCerebrasDailyLimit, uncertainReviewSkipReason } from './universalSignalParser'

describe('compareParseShadowDiff', () => {
  it('detects action mismatch between deterministic and universal', () => {
    const det = parseChannelMessageSync(PORTUGUESE_SCALP_SELL.rawMessage, DEFAULT_CHANNEL_KEYWORDS, null)
    const intent = coerceTradeIntent({
      kind: 'entry',
      side: 'SELL',
      symbol: 'XAUUSD',
      entry: [4060],
      sl: 4080,
      tp: [4055, 4050, 4040],
      confidence: 0.99,
    })
    const uniParsed = {
      parsed: tradeIntentToChannelParsedSignal(intent, PORTUGUESE_SCALP_SELL.rawMessage),
      status: 'parsed' as const,
      skip_reason: null,
    }
    const diff = compareParseShadowDiff(det, uniParsed)
    assert.equal(typeof diff.differs, 'boolean')
    assert.equal(diff.universal_action, 'sell')
  })
})

describe('isCerebrasDailyLimit', () => {
  it('detects the tokens-per-day 429', () => {
    assert.equal(
      isCerebrasDailyLimit(429, 'Tokens per day limit exceeded - too many tokens processed.'),
      true,
    )
  })

  it('detects the requests-per-day 429', () => {
    assert.equal(
      isCerebrasDailyLimit(429, 'Requests per day limit exceeded - too many requests sent.'),
      true,
    )
  })

  it('does not flag transient rate limits or other statuses', () => {
    assert.equal(isCerebrasDailyLimit(429, 'Rate limit reached. Please retry.'), false)
    assert.equal(isCerebrasDailyLimit(429, 'Too many concurrent requests'), false)
    assert.equal(isCerebrasDailyLimit(500, 'Tokens per day limit exceeded'), false)
  })
})

describe('cerebrasKeyOrder', () => {
  const noExhausted = () => false

  it('rotates the start index forward on every call', () => {
    const keys = ['a', 'b', 'c']
    assert.deepEqual(cerebrasKeyOrder(0, keys, noExhausted), [0, 1, 2])
    assert.deepEqual(cerebrasKeyOrder(1, keys, noExhausted), [1, 2, 0])
    assert.deepEqual(cerebrasKeyOrder(2, keys, noExhausted), [2, 0, 1])
  })

  it('skips exhausted keys but keeps rotation order for the rest', () => {
    const keys = ['a', 'b', 'c']
    const exhausted = (k: string) => k === 'b'
    assert.deepEqual(cerebrasKeyOrder(0, keys, exhausted), [0, 2])
    assert.deepEqual(cerebrasKeyOrder(1, keys, exhausted), [2, 0])
    assert.deepEqual(cerebrasKeyOrder(2, keys, exhausted), [2, 0])
  })

  it('returns an empty order when all keys are exhausted', () => {
    assert.deepEqual(cerebrasKeyOrder(0, ['a', 'b'], () => true), [])
  })

  it('returns an empty order for an empty key list', () => {
    assert.deepEqual(cerebrasKeyOrder(0, [], noExhausted), [])
  })

  it('handles a start index beyond the pool length', () => {
    assert.deepEqual(cerebrasKeyOrder(7, ['a', 'b', 'c'], noExhausted), [1, 2, 0])
  })
})

describe('uncertainReviewSkipReason', () => {
  const prev = process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  after(() => {
    if (prev != null) process.env.HUMAN_REVIEW_ESCALATION_ENABLED = prev
    else delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  })

  it('is an ordinary skip while review escalation is deactivated (default)', () => {
    delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
    assert.equal(uncertainReviewSkipReason(), 'AI classified as non-actionable')
  })

  it('marks the signal for review only while the flag is active', () => {
    process.env.HUMAN_REVIEW_ESCALATION_ENABLED = 'true'
    assert.equal(
      uncertainReviewSkipReason(),
      'AI classified as uncertain; human review required',
    )
    process.env.HUMAN_REVIEW_ESCALATION_ENABLED = 'false'
    assert.equal(uncertainReviewSkipReason(), 'AI classified as non-actionable')
  })
})
