import { describe, expect, it } from 'vitest'
import { buildFlags, isSignalSourceLocked, resolveBuildFlags } from './featureFlags'

describe('resolveBuildFlags', () => {
  it('keeps features visible when the variables are unset', () => {
    expect(resolveBuildFlags({})).toEqual({
      extraSourcesLocked: false,
      hideSocialTrading: false,
    })
  })

  it('keeps features visible for any value except "false"', () => {
    expect(resolveBuildFlags({ extraSources: 'true', socialTrading: 'TRUE' })).toEqual({
      extraSourcesLocked: false,
      hideSocialTrading: false,
    })
    expect(resolveBuildFlags({ extraSources: 'staging', socialTrading: '' })).toEqual({
      extraSourcesLocked: false,
      hideSocialTrading: false,
    })
  })

  it('locks a feature when its variable is "false"', () => {
    expect(resolveBuildFlags({ extraSources: 'false' })).toEqual({
      extraSourcesLocked: true,
      hideSocialTrading: false,
    })
    expect(resolveBuildFlags({ socialTrading: 'false' })).toEqual({
      extraSourcesLocked: false,
      hideSocialTrading: true,
    })
    expect(resolveBuildFlags({ extraSources: ' false ', socialTrading: 'FALSE' })).toEqual({
      extraSourcesLocked: true,
      hideSocialTrading: true,
    })
  })

  it('defaults to visible when this test environment sets no variables', () => {
    const extra = import.meta.env.VITE_ENABLE_EXTRA_SOURCES
    const social = import.meta.env.VITE_ENABLE_SOCIAL_TRADING
    // A developer's local .env may set the switches; the default path is covered above.
    if (extra !== undefined || social !== undefined) return
    expect(buildFlags).toEqual({
      extraSourcesLocked: false,
      hideSocialTrading: false,
    })
  })
})

describe('isSignalSourceLocked', () => {
  it('locks Discord only while the switch is off, and never TradingView', () => {
    // This test environment has no variables set, so nothing is locked.
    const locked = buildFlags.extraSourcesLocked
    expect(isSignalSourceLocked('discord')).toBe(locked)
    // TradingView has a worker, so it stays selectable in every build.
    expect(isSignalSourceLocked('tradingview')).toBe(false)
    expect(isSignalSourceLocked('whatsapp')).toBe(false)
    expect(isSignalSourceLocked('telegram')).toBe(false)
    expect(isSignalSourceLocked('broker')).toBe(false)
  })
})
