import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_ANNOUNCEMENT_LINK_LABEL,
  isExternalAnnouncementHref,
  normalizeAppAnnouncementRow,
} from './appAnnouncement'

describe('isExternalAnnouncementHref', () => {
  it('treats http(s) and protocol-relative URLs as external', () => {
    expect(isExternalAnnouncementHref('https://example.com')).toBe(true)
    expect(isExternalAnnouncementHref('http://example.com')).toBe(true)
    expect(isExternalAnnouncementHref('//cdn.example.com/x')).toBe(true)
  })

  it('treats app paths as internal', () => {
    expect(isExternalAnnouncementHref('/brokers')).toBe(false)
    expect(isExternalAnnouncementHref('/banners')).toBe(false)
  })
})

describe('normalizeAppAnnouncementRow', () => {
  it('includes link fields when href is set', () => {
    const state = normalizeAppAnnouncementRow({
      enabled: true,
      message: 'New feature',
      link_href: '/brokers',
      link_label: null,
    })
    expect(state.enabled).toBe(true)
    expect(state.linkHref).toBe('/brokers')
    expect(state.linkLabel).toBe(DEFAULT_APP_ANNOUNCEMENT_LINK_LABEL)
  })

  it('omits link when href is empty', () => {
    const state = normalizeAppAnnouncementRow({
      enabled: true,
      message: 'News only',
      link_href: '  ',
    })
    expect(state.linkHref).toBeNull()
    expect(state.linkLabel).toBeNull()
  })
})
