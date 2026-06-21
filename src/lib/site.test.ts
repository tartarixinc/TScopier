import { describe, expect, it, vi, afterEach } from 'vitest'
import { isAppHost, appUrl, marketingUrl } from './site'

function mockLocation(hostname: string, search = '') {
  const loc = {
    hostname,
    search,
    href: `https://${hostname}/${search.replace(/^\?/, '')}`,
  }
  vi.stubGlobal('window', { location: loc })
  vi.stubGlobal('location', loc)
}

describe('isAppHost', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses marketing override from ?site=marketing on localhost', () => {
    mockLocation('127.0.0.1', '?site=marketing')
    expect(isAppHost()).toBe(false)
  })

  it('uses app override from ?site=app on localhost', () => {
    mockLocation('127.0.0.1', '?site=app')
    expect(isAppHost()).toBe(true)
  })

  it('defaults localhost to app without override', () => {
    mockLocation('127.0.0.1', '')
    expect(isAppHost()).toBe(true)
  })

  it('treats tscopier.ai as marketing host', () => {
    mockLocation('tscopier.ai', '')
    expect(isAppHost()).toBe(false)
  })

  it('treats app.tscopier.ai as app host', () => {
    mockLocation('app.tscopier.ai', '')
    expect(isAppHost()).toBe(true)
  })
})

describe('appUrl / marketingUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appUrl returns relative path on app host', () => {
    mockLocation('app.tscopier.ai', '')
    expect(appUrl('/dashboard')).toBe('/dashboard')
  })

  it('marketingUrl returns relative path on marketing host', () => {
    mockLocation('tscopier.ai', '')
    expect(marketingUrl('/')).toBe('/')
  })
})
