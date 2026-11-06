import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  POST_AUTH_REDIRECT_TTL_MS,
  capturePostAuthRedirectFromUrl,
  consumePostAuthRedirect,
  isSafeInternalPath,
  peekPostAuthRedirect,
  providerCopyLandingPath,
  stashPostAuthRedirect,
} from './postAuthRedirect'
import { postAuthAppPath, stashPendingPlanSelection } from './pendingPlanSelection'

describe('postAuthRedirect', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => { localStorage.clear(); sessionStorage.clear() })

  it('stashes, peeks without clearing, and consumes exactly once', () => {
    expect(stashPostAuthRedirect('/social-trading/abc?copy=1')).toBe(true)
    expect(peekPostAuthRedirect()).toBe('/social-trading/abc?copy=1')
    expect(peekPostAuthRedirect()).toBe('/social-trading/abc?copy=1')
    expect(consumePostAuthRedirect()).toBe('/social-trading/abc?copy=1')
    expect(consumePostAuthRedirect()).toBeNull()
  })

  it('expires after the TTL', () => {
    const now = 1_000_000
    stashPostAuthRedirect('/social-trading/abc', now)
    expect(peekPostAuthRedirect(now + POST_AUTH_REDIRECT_TTL_MS - 1)).toBe('/social-trading/abc')
    expect(peekPostAuthRedirect(now + POST_AUTH_REDIRECT_TTL_MS + 1)).toBeNull()
    expect(localStorage.getItem('tsc_post_auth_redirect')).toBeNull()
  })

  it('rejects external, protocol-relative and malformed targets', () => {
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/a\\b', '/a\nb', '']) {
      expect(isSafeInternalPath(bad)).toBe(false)
      expect(stashPostAuthRedirect(bad)).toBe(false)
    }
    localStorage.setItem('tsc_post_auth_redirect', JSON.stringify({ path: '//evil.example', at: Date.now() }))
    expect(peekPostAuthRedirect()).toBeNull()
    localStorage.setItem('tsc_post_auth_redirect', 'not json')
    expect(peekPostAuthRedirect()).toBeNull()
  })

  it('builds the provider copy landing path', () => {
    expect(providerCopyLandingPath('u-1')).toBe('/social-trading/u-1?copy=1')
  })

  it('sends visitors back to the provider after auth, but a pending plan keeps priority', () => {
    expect(postAuthAppPath()).toBe('/dashboard')
    stashPostAuthRedirect('/social-trading/u-1?copy=1')
    expect(postAuthAppPath()).toBe('/social-trading/u-1?copy=1')
    stashPendingPlanSelection({ plan: 'basic', interval: 'monthly', extraAccounts: 0 })
    expect(postAuthAppPath()).toBe('/pricing?startCheckout=1')
    expect(peekPostAuthRedirect()).toBe('/social-trading/u-1?copy=1')
  })

  it('captures a next path from the URL (marketing -> app hand-off) and ignores unsafe ones', () => {
    expect(capturePostAuthRedirectFromUrl('?next=%2Fsocial-trading%2Fu-1%3Fcopy%3D1')).toBe('/social-trading/u-1?copy=1')
    expect(peekPostAuthRedirect()).toBe('/social-trading/u-1?copy=1')
    localStorage.clear()
    expect(capturePostAuthRedirectFromUrl('?next=https%3A%2F%2Fevil.example')).toBeNull()
    expect(capturePostAuthRedirectFromUrl('?next=%2F%2Fevil.example')).toBeNull()
    expect(capturePostAuthRedirectFromUrl('')).toBeNull()
    expect(peekPostAuthRedirect()).toBeNull()
  })
})
