import { describe, expect, it } from 'vitest'
import { isAdminAccessActive } from './adminAccess'

describe('isAdminAccessActive', () => {
  it('returns false when not admin', () => {
    expect(isAdminAccessActive({ is_admin: false })).toBe(false)
    expect(isAdminAccessActive(null)).toBe(false)
  })

  it('returns true for permanent admin', () => {
    expect(isAdminAccessActive({ is_admin: true, admin_until: null })).toBe(true)
    expect(isAdminAccessActive({ is_admin: true })).toBe(true)
  })

  it('returns true when until is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(isAdminAccessActive({ is_admin: true, admin_until: future })).toBe(true)
  })

  it('returns false when until is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(isAdminAccessActive({ is_admin: true, admin_until: past })).toBe(false)
  })
})
