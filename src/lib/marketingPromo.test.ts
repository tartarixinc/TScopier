import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROMO_CTA_LABEL,
  countdownParts,
  isExternalPromoHref,
  normalizeMarketingPromoRow,
  promoMediaKind,
  promoRevision,
  sanitizePromoHref,
} from './marketingPromo'

const NOW = Date.parse('2026-10-20T12:00:00Z')

describe('sanitizePromoHref', () => {
  it('keeps site paths and https URLs', () => {
    expect(sanitizePromoHref('/pricing')).toBe('/pricing')
    expect(sanitizePromoHref(' https://example.com/deal?x=1 ')).toBe('https://example.com/deal?x=1')
  })

  it('drops anything that could leave the site unexpectedly or run script', () => {
    for (const bad of ['', '//evil.com', '/\\evil.com', 'http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'pricing', 'https://']) {
      expect(sanitizePromoHref(bad), bad).toBeNull()
    }
    expect(sanitizePromoHref(null)).toBeNull()
  })
})

describe('isExternalPromoHref', () => {
  it('tells paths from URLs', () => {
    expect(isExternalPromoHref('https://example.com')).toBe(true)
    expect(isExternalPromoHref('/pricing')).toBe(false)
  })
})

describe('promoMediaKind', () => {
  it('treats mp4, webm and mov as video and GIFs as images', () => {
    expect(promoMediaKind('https://x.co/a.mp4')).toBe('video')
    expect(promoMediaKind('https://x.co/a.WEBM?v=2')).toBe('video')
    expect(promoMediaKind('/a.mov')).toBe('video')
    expect(promoMediaKind('https://x.co/a.gif')).toBe('image')
    expect(promoMediaKind('https://x.co/a.png')).toBe('image')
    expect(promoMediaKind('https://x.co/a.webp#t')).toBe('image')
  })
})

describe('normalizeMarketingPromoRow', () => {
  const live = {
    id: 'p1',
    enabled: true,
    headline: ' Halloween Special: 55% OFF ',
    coupon_code: ' SPOOKY55 ',
    cta_label: ' Get Code ',
    cta_href: '/pricing',
    media_url: 'https://x.co/banner.mp4',
    ends_at: '2026-10-23T12:00:00Z',
  }

  it('trims a live row and keeps its fields', () => {
    expect(normalizeMarketingPromoRow(live, NOW)).toEqual({
      id: 'p1',
      headline: 'Halloween Special: 55% OFF',
      couponCode: 'SPOOKY55',
      ctaLabel: 'Get Code',
      ctaHref: '/pricing',
      mediaUrl: 'https://x.co/banner.mp4',
      mediaUrlMobile: null,
      startsAt: null,
      endsAt: Date.parse('2026-10-23T12:00:00Z'),
      dismissible: true,
    })
  })

  it('hides disabled, not yet started and ended rows', () => {
    expect(normalizeMarketingPromoRow({ ...live, enabled: false }, NOW)).toBeNull()
    expect(normalizeMarketingPromoRow({ ...live, starts_at: '2026-10-21T00:00:00Z' }, NOW)).toBeNull()
    expect(normalizeMarketingPromoRow({ ...live, ends_at: '2026-10-20T12:00:00Z' }, NOW)).toBeNull()
    expect(normalizeMarketingPromoRow(null, NOW)).toBeNull()
  })

  it('defaults the button label and drops a label with no valid link', () => {
    expect(normalizeMarketingPromoRow({ ...live, cta_label: null }, NOW)?.ctaLabel).toBe(DEFAULT_PROMO_CTA_LABEL)
    const noLink = normalizeMarketingPromoRow({ ...live, cta_href: 'javascript:alert(1)' }, NOW)
    expect(noLink?.ctaHref).toBeNull()
    expect(noLink?.ctaLabel).toBeNull()
  })

  it('shows nothing when the row has no content at all', () => {
    expect(normalizeMarketingPromoRow({ id: 'x', enabled: true }, NOW)).toBeNull()
  })

  it('respects dismissible=false', () => {
    expect(normalizeMarketingPromoRow({ ...live, dismissible: false }, NOW)?.dismissible).toBe(false)
  })
})

describe('countdownParts', () => {
  it('splits the remaining time', () => {
    const end = NOW + ((1 * 24 + 19) * 3600 + 40 * 60 + 21) * 1000
    expect(countdownParts(end, NOW)).toEqual({ days: 1, hours: 19, minutes: 40, seconds: 21, done: false })
  })

  it('clamps at zero once the end has passed', () => {
    expect(countdownParts(NOW - 5000, NOW)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0, done: true })
    expect(countdownParts(NOW, NOW).done).toBe(true)
  })
})

describe('promoRevision', () => {
  const base = { id: 'p1', headline: 'h', couponCode: 'C', ctaHref: '/pricing', endsAt: 1 }
  it('changes when the campaign changes', () => {
    expect(promoRevision(base)).toBe(promoRevision({ ...base }))
    expect(promoRevision(base)).not.toBe(promoRevision({ ...base, couponCode: 'D' }))
    expect(promoRevision(base)).not.toBe(promoRevision({ ...base, endsAt: 2 }))
  })
})
