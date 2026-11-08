import { describe, expect, it } from 'vitest'
import { grantEndMs, isExtensionActive, latestExtensionEndMs } from './subscriptionExtensions'

const DAY = 86_400_000

describe('grantEndMs', () => {
  it('ends a grant seven days after it was granted', () => {
    const end = grantEndMs({ days: 7, granted_at: '2026-11-01T00:00:00.000Z' })
    expect(end).toBe(Date.parse('2026-11-01T00:00:00.000Z') + 7 * DAY)
  })

  it('rejects unusable rows', () => {
    expect(grantEndMs({ days: 0, granted_at: '2026-11-01T00:00:00.000Z' })).toBeNull()
    expect(grantEndMs({ days: 7, granted_at: 'not-a-date' })).toBeNull()
    expect(grantEndMs({ days: Number.NaN, granted_at: '2026-11-01T00:00:00.000Z' })).toBeNull()
  })
})

describe('latestExtensionEndMs', () => {
  it('returns null when there are no grants', () => {
    expect(latestExtensionEndMs(null)).toBeNull()
    expect(latestExtensionEndMs([])).toBeNull()
    expect(latestExtensionEndMs(undefined)).toBeNull()
  })

  it('returns the latest end across grants', () => {
    const latest = latestExtensionEndMs([
      { days: 3, granted_at: '2026-11-01T00:00:00.000Z' },
      { days: 14, granted_at: '2026-11-10T00:00:00.000Z' },
      { days: 7, granted_at: '2026-10-01T00:00:00.000Z' },
    ])
    expect(latest).toBe(Date.parse('2026-11-10T00:00:00.000Z') + 14 * DAY)
  })

  it('ignores unusable rows', () => {
    const latest = latestExtensionEndMs([
      { days: 7, granted_at: 'not-a-date' },
      { days: 3, granted_at: '2026-11-01T00:00:00.000Z' },
    ])
    expect(latest).toBe(Date.parse('2026-11-01T00:00:00.000Z') + 3 * DAY)
  })
})

describe('isExtensionActive', () => {
  it('is active only while the window is open', () => {
    expect(isExtensionActive(null)).toBe(false)
    expect(isExtensionActive(Date.now() + 60_000)).toBe(true)
    expect(isExtensionActive(Date.now() - 60_000)).toBe(false)
  })

  it('treats the exact end moment as expired', () => {
    const now = Date.parse('2026-11-21T00:00:00.000Z')
    expect(isExtensionActive(now, now)).toBe(false)
    expect(isExtensionActive(now + 1, now)).toBe(true)
  })
})
