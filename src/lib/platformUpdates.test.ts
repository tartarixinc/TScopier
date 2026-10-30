import { describe, expect, it, vi } from 'vitest'
import {
  allPlatformUpdateIds,
  latestUnseenUpdate,
  markUpdateIdsSeen,
  readSeenUpdateIds,
  type PlatformUpdate,
} from './platformUpdates'

const updates: PlatformUpdate[] = [
  { id: 'a', date: '2026-09-15', title: 'A', description: 'a', type: 'feature' },
  { id: 'b', date: '2026-09-15', title: 'B', description: 'b', type: 'feature' },
]

describe('platform update seen tracking', () => {
  it('lists every update id', () => {
    expect(allPlatformUpdateIds(updates)).toEqual(['a', 'b'])
  })

  it('returns the latest unseen update', () => {
    expect(latestUnseenUpdate(updates, new Set())?.id).toBe('a')
    expect(latestUnseenUpdate(updates, new Set(['a']))?.id).toBe('b')
  })

  it('returns null once every update is seen', () => {
    expect(latestUnseenUpdate(updates, new Set(['a', 'b']))).toBeNull()
  })

  it('does not throw when marking updates seen without storage', () => {
    expect(() => markUpdateIdsSeen(['a', 'b'])).not.toThrow()
  })

  it('persists and reads back ids without throwing on malformed data', () => {
    const store = new Map<string, string>([['tscopier_seen_updates', 'not json']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size
      },
    })

    expect(() => readSeenUpdateIds()).not.toThrow()
    markUpdateIdsSeen(['z'])
    expect(readSeenUpdateIds().has('z')).toBe(true)

    vi.unstubAllGlobals()
  })
})
