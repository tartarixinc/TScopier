import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { clearSessionCacheKey, peekSessionCache } from './sessionDataCache'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }
}

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: new MemoryStorage(),
})

describe('peekSessionCache', () => {
  beforeEach(() => {
    sessionStorage.clear()
    clearSessionCacheKey('peek-test')
  })

  it('does not evict a stale entry that a longer-lived reader still needs', () => {
    const key = 'peek-test'
    sessionStorage.setItem(
      `tscopier:data:${key}`,
      JSON.stringify({ data: { value: 1 }, fetchedAt: Date.now() - 120_000 }),
    )

    assert.equal(peekSessionCache(key, 60_000), null)
    assert.deepEqual(peekSessionCache(key, 24 * 60 * 60 * 1000)?.data, { value: 1 })
  })
})
