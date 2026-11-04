import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'
import { resolveUserAvatarUrl, userInitials } from './userAvatar'

describe('userInitials', () => {
  it('uses first and last name when both present', () => {
    expect(userInitials({ first_name: 'Jane', last_name: 'Doe' })).toBe('JD')
  })

  it('falls back to email prefix', () => {
    expect(userInitials({}, 'alice@example.com')).toBe('AL')
  })
})

describe('resolveUserAvatarUrl', () => {
  it('returns null when user is missing', () => {
    expect(resolveUserAvatarUrl(null)).toBeNull()
  })

  it('prefers an uploaded profile photo over the sign-in photo', () => {
    const user = {
      user_metadata: { avatar_url: 'https://example.com/oauth.jpg' },
    } as User
    expect(resolveUserAvatarUrl(user, { avatar_url: 'https://example.com/profile.jpg' })).toBe(
      'https://example.com/profile.jpg',
    )
  })

  it('reads avatar_url from user metadata', () => {
    const user = {
      user_metadata: { avatar_url: 'https://example.com/a.jpg' },
    } as User
    expect(resolveUserAvatarUrl(user)).toBe('https://example.com/a.jpg')
  })

  it('falls back to picture in identity data', () => {
    const user = {
      user_metadata: {},
      identities: [{ identity_data: { picture: 'https://example.com/p.jpg' } }],
    } as User
    expect(resolveUserAvatarUrl(user)).toBe('https://example.com/p.jpg')
  })
})
