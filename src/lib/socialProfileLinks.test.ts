import { describe, expect, it } from 'vitest'
import { normalizeSocialProfileLinks, safeExternalSocialUrl, validateSocialProfileLinks } from './socialProfileLinks'

describe('social profile links', () => {
  it('normalizes supported links and removes empty or unknown fields', () => {
    expect(normalizeSocialProfileLinks({ x: ' https://x.com/trader ', instagram: '', unknown: 'https://example.com' })).toEqual({
      x: 'https://x.com/trader',
    })
  })

  it('accepts supported HTTPS profile hosts', () => {
    expect(validateSocialProfileLinks({
      x: 'https://x.com/trader',
      linkedin: 'https://www.linkedin.com/in/trader',
      youtube: 'https://youtube.com/@trader',
    })).toBeNull()
  })

  it.each([
    ['http://x.com/trader'],
    ['https://x.com.evil.example/trader'],
    ['https://user:secret@x.com/trader'],
    ['javascript:alert(1)'],
  ])('rejects unsafe X URL %s', value => {
    expect(validateSocialProfileLinks({ x: value })).not.toBeNull()
    expect(safeExternalSocialUrl('x', value)).toBeNull()
  })

  it('accepts Telegram profile links and rejects look-alike hosts', () => {
    expect(validateSocialProfileLinks({ telegram: 'https://t.me/trader' })).toBeNull()
    expect(validateSocialProfileLinks({ telegram: 'https://telegram.me/trader' })).toBeNull()
    expect(validateSocialProfileLinks({ telegram: 'https://t.me' })).not.toBeNull()
    expect(validateSocialProfileLinks({ telegram: 'https://t.me.evil.example/trader' })).not.toBeNull()
    expect(safeExternalSocialUrl('telegram', 'http://t.me/trader')).toBeNull()
  })
})
