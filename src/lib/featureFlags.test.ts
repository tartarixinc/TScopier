import { describe, expect, it } from 'vitest'
import { buildFlags, resolveBuildFlags } from './featureFlags'

describe('resolveBuildFlags', () => {
  it('keeps features visible when the variables are unset', () => {
    expect(resolveBuildFlags({})).toEqual({
      telegramOnlySourcePicker: false,
      hideSocialTrading: false,
    })
  })

  it('keeps features visible for any value except "false"', () => {
    expect(resolveBuildFlags({ extraSources: 'true', socialTrading: 'TRUE' })).toEqual({
      telegramOnlySourcePicker: false,
      hideSocialTrading: false,
    })
    expect(resolveBuildFlags({ extraSources: 'staging', socialTrading: '' })).toEqual({
      telegramOnlySourcePicker: false,
      hideSocialTrading: false,
    })
  })

  it('locks a feature when its variable is "false"', () => {
    expect(resolveBuildFlags({ extraSources: 'false' })).toEqual({
      telegramOnlySourcePicker: true,
      hideSocialTrading: false,
    })
    expect(resolveBuildFlags({ socialTrading: 'false' })).toEqual({
      telegramOnlySourcePicker: false,
      hideSocialTrading: true,
    })
    expect(resolveBuildFlags({ extraSources: ' false ', socialTrading: 'FALSE' })).toEqual({
      telegramOnlySourcePicker: true,
      hideSocialTrading: true,
    })
  })

  it('defaults to visible when this test environment sets no variables', () => {
    const extra = import.meta.env.VITE_ENABLE_EXTRA_SOURCES
    const social = import.meta.env.VITE_ENABLE_SOCIAL_TRADING
    // A developer's local .env may set the switches; the default path is covered above.
    if (extra !== undefined || social !== undefined) return
    expect(buildFlags).toEqual({
      telegramOnlySourcePicker: false,
      hideSocialTrading: false,
    })
  })
})
