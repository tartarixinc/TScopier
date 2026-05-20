import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseTradeWorkerShardUrls, validateListenerTradeShardConfig } from './tradeSignalPush'

describe('parseTradeWorkerShardUrls', () => {
  it('trims and strips trailing slashes', () => {
    const urls = parseTradeWorkerShardUrls(' https://a.example.com/ , https://b.example.com ')
    assert.deepEqual(urls, ['https://a.example.com', 'https://b.example.com'])
  })
})

describe('validateListenerTradeShardConfig', () => {
  const prevUrls = process.env.TRADE_WORKER_SHARD_URLS
  const prevCount = process.env.TRADE_WORKER_SHARD_COUNT

  afterEach(() => {
    if (prevUrls === undefined) delete process.env.TRADE_WORKER_SHARD_URLS
    else process.env.TRADE_WORKER_SHARD_URLS = prevUrls
    if (prevCount === undefined) delete process.env.TRADE_WORKER_SHARD_COUNT
    else process.env.TRADE_WORKER_SHARD_COUNT = prevCount
  })

  it('returns null when shard URLs unset', () => {
    delete process.env.TRADE_WORKER_SHARD_URLS
    assert.equal(validateListenerTradeShardConfig(), null)
  })

  it('returns null when URL count matches TRADE_WORKER_SHARD_COUNT', () => {
    process.env.TRADE_WORKER_SHARD_URLS = 'https://a.example.com,https://b.example.com'
    process.env.TRADE_WORKER_SHARD_COUNT = '2'
    assert.equal(validateListenerTradeShardConfig(), null)
  })

  it('returns error when URL count mismatches TRADE_WORKER_SHARD_COUNT', () => {
    process.env.TRADE_WORKER_SHARD_URLS = 'https://a.example.com,https://b.example.com'
    process.env.TRADE_WORKER_SHARD_COUNT = '3'
    const err = validateListenerTradeShardConfig()
    assert.ok(err?.includes('2 URL'))
    assert.ok(err?.includes('TRADE_WORKER_SHARD_COUNT=3'))
  })
})
