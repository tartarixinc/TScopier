import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { User } from '@supabase/supabase-js'
import {
  isEmailVerified,
  isOAuthUser,
  isUnconfirmedEmailAuthError,
  verifyEmailPath,
} from './emailVerification'

function userWith(
  confirmedAt: string | null,
  providers: string[] = ['email'],
): User {
  return {
    id: 'user-1',
    email: 'test@example.com',
    email_confirmed_at: confirmedAt,
    app_metadata: { providers },
  } as User
}

describe('isOAuthUser', () => {
  it('detects Google OAuth', () => {
    assert.equal(isOAuthUser(userWith('2026-01-01T00:00:00Z', ['google'])), true)
  })

  it('returns false for email-only signup', () => {
    assert.equal(isOAuthUser(userWith(null, ['email'])), false)
  })
})

describe('isEmailVerified', () => {
  it('returns false when email/password user has no profile verification', () => {
    assert.equal(isEmailVerified(userWith(null), null), false)
    assert.equal(isEmailVerified(userWith('2026-01-01T00:00:00Z'), null), false)
    assert.equal(isEmailVerified(null, null), false)
  })

  it('returns true when email/password profile is verified', () => {
    assert.equal(
      isEmailVerified(userWith('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z'),
      true,
    )
  })

  it('returns true for OAuth when Supabase confirms email', () => {
    assert.equal(
      isEmailVerified(userWith('2026-01-01T00:00:00Z', ['google']), null),
      true,
    )
  })
})

describe('verifyEmailPath', () => {
  it('builds query string when email is present', () => {
    assert.equal(
      verifyEmailPath('user@example.com'),
      '/verify-email?email=user%40example.com',
    )
  })

  it('omits query when email is empty', () => {
    assert.equal(verifyEmailPath(''), '/verify-email')
  })
})

describe('isUnconfirmedEmailAuthError', () => {
  it('detects Supabase unconfirmed email errors', () => {
    assert.equal(isUnconfirmedEmailAuthError({ code: 'email_not_confirmed' }), true)
    assert.equal(isUnconfirmedEmailAuthError({ message: 'Email not confirmed' }), true)
    assert.equal(isUnconfirmedEmailAuthError({ message: 'Invalid login credentials' }), false)
  })
})
