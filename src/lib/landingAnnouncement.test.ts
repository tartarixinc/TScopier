import { describe, expect, it } from 'vitest'
import { normalizeLandingAnnouncementRow } from './landingAnnouncement'

describe('normalizeLandingAnnouncementRow', () => {
  const row = {
    id: 'a1',
    message: 'TScopier.ai is now UniCopier',
    translations: { fr: 'TScopier.ai devient UniCopier', es: '  ' },
    link_href: null,
    link_label: 'ignored without href',
  }

  it('returns null without a row or message', () => {
    expect(normalizeLandingAnnouncementRow(null, 'en')).toBeNull()
    expect(normalizeLandingAnnouncementRow({ message: '   ' }, 'en')).toBeNull()
  })

  it('prefers the visitor locale and falls back to the default message', () => {
    expect(normalizeLandingAnnouncementRow(row, 'fr')?.message).toBe('TScopier.ai devient UniCopier')
    expect(normalizeLandingAnnouncementRow(row, 'en')?.message).toBe('TScopier.ai is now UniCopier')
    expect(normalizeLandingAnnouncementRow(row, 'es')?.message).toBe('TScopier.ai is now UniCopier')
  })

  it('keeps the link label only when there is a link', () => {
    expect(normalizeLandingAnnouncementRow(row, 'en')?.linkLabel).toBeNull()
    const linked = normalizeLandingAnnouncementRow({ ...row, link_href: '/pricing', link_label: 'See plans' }, 'en')
    expect(linked?.linkHref).toBe('/pricing')
    expect(linked?.linkLabel).toBe('See plans')
  })

  it('tolerates malformed translations', () => {
    expect(normalizeLandingAnnouncementRow({ ...row, translations: ['x'] }, 'fr')?.message).toBe('TScopier.ai is now UniCopier')
    expect(normalizeLandingAnnouncementRow({ ...row, translations: null }, 'fr')?.message).toBe('TScopier.ai is now UniCopier')
  })
})
