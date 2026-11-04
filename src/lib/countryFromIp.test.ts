import { describe, expect, it } from 'vitest'
import { countryCodeFromGeoPayload } from './countryFromIp'

describe('countryCodeFromGeoPayload', () => {
  it('reads a two-letter country code', () => {
    expect(countryCodeFromGeoPayload({ country: 'ng' })).toBe('NG')
  })

  it('ignores a missing or invalid country', () => {
    expect(countryCodeFromGeoPayload({})).toBeNull()
    expect(countryCodeFromGeoPayload({ country: 'Nigeria' })).toBeNull()
    expect(countryCodeFromGeoPayload(null)).toBeNull()
  })
})
