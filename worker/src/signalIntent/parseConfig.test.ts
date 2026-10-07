import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  cerebrasParseApiKeys,
  cerebrasParseMaxTokens,
  cerebrasParseModel,
  cerebrasParseRetries,
  getUniversalParseMode,
  humanReviewEscalationEnabled,
  isUniversalParseEnabled,
  universalParseReconcileModel,
  universalParseReconcileTimeoutMs,
} from './parseConfig'

describe('parseConfig', () => {
  const prevMode = process.env.UNIVERSAL_PARSE_MODE
  const prevEnabled = process.env.UNIVERSAL_PARSE_ENABLED
  const prevCerebrasModel = process.env.CEREBRAS_PARSE_MODEL
  const prevReconcileModel = process.env.UNIVERSAL_PARSE_RECONCILE_MODEL
  const prevReconcileTimeout = process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS
  const prevCerebrasMaxTokens = process.env.CEREBRAS_PARSE_MAX_TOKENS
  const prevCerebrasRetries = process.env.CEREBRAS_PARSE_RETRIES
  const prevCerebrasKey1 = process.env.CEREBRAS_API_KEY_1
  const prevCerebrasKey2 = process.env.CEREBRAS_API_KEY_2
  const prevCerebrasKey3 = process.env.CEREBRAS_API_KEY_3
  const prevCerebrasKey = process.env.CEREBRAS_API_KEY

  after(() => {
    if (prevMode != null) process.env.UNIVERSAL_PARSE_MODE = prevMode
    else delete process.env.UNIVERSAL_PARSE_MODE
    if (prevEnabled != null) process.env.UNIVERSAL_PARSE_ENABLED = prevEnabled
    else delete process.env.UNIVERSAL_PARSE_ENABLED
    if (prevCerebrasModel != null) process.env.CEREBRAS_PARSE_MODEL = prevCerebrasModel
    else delete process.env.CEREBRAS_PARSE_MODEL
    if (prevReconcileModel != null) process.env.UNIVERSAL_PARSE_RECONCILE_MODEL = prevReconcileModel
    else delete process.env.UNIVERSAL_PARSE_RECONCILE_MODEL
    if (prevReconcileTimeout != null) {
      process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS = prevReconcileTimeout
    } else {
      delete process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS
    }
    if (prevCerebrasMaxTokens != null) {
      process.env.CEREBRAS_PARSE_MAX_TOKENS = prevCerebrasMaxTokens
    } else {
      delete process.env.CEREBRAS_PARSE_MAX_TOKENS
    }
    if (prevCerebrasRetries != null) {
      process.env.CEREBRAS_PARSE_RETRIES = prevCerebrasRetries
    } else {
      delete process.env.CEREBRAS_PARSE_RETRIES
    }
    if (prevCerebrasKey1 != null) process.env.CEREBRAS_API_KEY_1 = prevCerebrasKey1
    else delete process.env.CEREBRAS_API_KEY_1
    if (prevCerebrasKey2 != null) process.env.CEREBRAS_API_KEY_2 = prevCerebrasKey2
    else delete process.env.CEREBRAS_API_KEY_2
    if (prevCerebrasKey3 != null) process.env.CEREBRAS_API_KEY_3 = prevCerebrasKey3
    else delete process.env.CEREBRAS_API_KEY_3
    if (prevCerebrasKey != null) process.env.CEREBRAS_API_KEY = prevCerebrasKey
    else delete process.env.CEREBRAS_API_KEY
  })

  it('defaults to shadow mode when UNIVERSAL_PARSE_MODE is unset', () => {
    delete process.env.UNIVERSAL_PARSE_MODE
    assert.equal(getUniversalParseMode(), 'shadow')
  })

  it('respects fastpath mode from env', () => {
    process.env.UNIVERSAL_PARSE_MODE = 'fastpath'
    assert.equal(getUniversalParseMode(), 'fastpath')
  })

  it('is enabled by default', () => {
    delete process.env.UNIVERSAL_PARSE_ENABLED
    delete process.env.UNIVERSAL_PARSE_MODE
    assert.equal(isUniversalParseEnabled(), true)
  })

  it('defaults the stage 2 Cerebras model to gpt-oss-120b', () => {
    delete process.env.CEREBRAS_PARSE_MODEL
    assert.equal(cerebrasParseModel(), 'gpt-oss-120b')
  })

  it('respects CEREBRAS_PARSE_MODEL from env', () => {
    process.env.CEREBRAS_PARSE_MODEL = 'gpt-oss-20b'
    assert.equal(cerebrasParseModel(), 'gpt-oss-20b')
  })

  it('defaults the stage 3 reconcile model to gpt-4o', () => {
    delete process.env.UNIVERSAL_PARSE_RECONCILE_MODEL
    assert.equal(universalParseReconcileModel(), 'gpt-4o')
  })

  it('bounds the reconcile timeout', () => {
    delete process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS
    assert.equal(universalParseReconcileTimeoutMs(), 8000)
    process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS = '99'
    assert.equal(universalParseReconcileTimeoutMs(), 1000)
    process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS = '99999'
    assert.equal(universalParseReconcileTimeoutMs(), 30000)
  })

  it('defaults Cerebras max tokens to 2000 so the reasoning model finishes', () => {
    delete process.env.CEREBRAS_PARSE_MAX_TOKENS
    assert.equal(cerebrasParseMaxTokens(), 2000)
    process.env.CEREBRAS_PARSE_MAX_TOKENS = '5000'
    assert.equal(cerebrasParseMaxTokens(), 5000)
    process.env.CEREBRAS_PARSE_MAX_TOKENS = 'not-a-number'
    assert.equal(cerebrasParseMaxTokens(), 2000)
  })

  it('defaults Cerebras retries to 2 and bounds them', () => {
    delete process.env.CEREBRAS_PARSE_RETRIES
    assert.equal(cerebrasParseRetries(), 2)
    process.env.CEREBRAS_PARSE_RETRIES = '9'
    assert.equal(cerebrasParseRetries(), 5)
    process.env.CEREBRAS_PARSE_RETRIES = '0'
    assert.equal(cerebrasParseRetries(), 0)
  })

  it('falls back to the legacy single CEREBRAS_API_KEY', () => {
    delete process.env.CEREBRAS_API_KEY_1
    delete process.env.CEREBRAS_API_KEY_2
    delete process.env.CEREBRAS_API_KEY_3
    process.env.CEREBRAS_API_KEY = 'sk-legacy'
    assert.deepEqual(cerebrasParseApiKeys(), ['sk-legacy'])
  })

  it('collects numbered CEREBRAS_API_KEY_N vars in order, stopping at the first gap', () => {
    process.env.CEREBRAS_API_KEY_1 = 'key-a'
    process.env.CEREBRAS_API_KEY_2 = 'key-b'
    process.env.CEREBRAS_API_KEY_3 = 'key-c'
    process.env.CEREBRAS_API_KEY = 'sk-ignored'
    assert.deepEqual(cerebrasParseApiKeys(), ['key-a', 'key-b', 'key-c'])
  })

  it('stops at the first missing numbered key', () => {
    process.env.CEREBRAS_API_KEY_1 = 'key-a'
    delete process.env.CEREBRAS_API_KEY_2
    process.env.CEREBRAS_API_KEY_3 = 'key-c'
    assert.deepEqual(cerebrasParseApiKeys(), ['key-a'])
  })

  it('returns an empty list when no Cerebras key is configured', () => {
    delete process.env.CEREBRAS_API_KEY_1
    delete process.env.CEREBRAS_API_KEY_2
    delete process.env.CEREBRAS_API_KEY_3
    delete process.env.CEREBRAS_API_KEY
    assert.deepEqual(cerebrasParseApiKeys(), [])
  })
})

describe('humanReviewEscalationEnabled', () => {
  const prev = process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  after(() => {
    if (prev != null) process.env.HUMAN_REVIEW_ESCALATION_ENABLED = prev
    else delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  })

  it('is deactivated by default', () => {
    delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
    assert.equal(humanReviewEscalationEnabled(), false)
  })

  it('activates on true/1/yes', () => {
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      process.env.HUMAN_REVIEW_ESCALATION_ENABLED = v
      assert.equal(humanReviewEscalationEnabled(), true, `expected true for ${v}`)
    }
  })

  it('deactivates on false/0/no', () => {
    for (const v of ['false', '0', 'no']) {
      process.env.HUMAN_REVIEW_ESCALATION_ENABLED = v
      assert.equal(humanReviewEscalationEnabled(), false, `expected false for ${v}`)
    }
  })
})
