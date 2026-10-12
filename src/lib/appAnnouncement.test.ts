import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_ANNOUNCEMENT_LINK_LABEL,
  appAnnouncementRevision,
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

  it('treats a changed message or link as a new announcement', () => {
    const current = appAnnouncementRevision({
      enabled: true,
      message: 'Maintenance tonight',
      linkHref: '/updates',
      linkLabel: 'Details',
    })
    const edited = appAnnouncementRevision({
      enabled: true,
      message: 'Maintenance moved to Friday',
      linkHref: '/updates',
      linkLabel: 'Details',
    })
    expect(current).toBeTruthy()
    expect(edited).not.toBe(current)
    expect(appAnnouncementRevision({
      enabled: false,
      message: 'Maintenance tonight',
      linkHref: null,
      linkLabel: null,
    })).toBeNull()
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
