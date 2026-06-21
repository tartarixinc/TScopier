import { describe, expect, it } from 'vitest'
import { isRouteAllowedWithoutSubscription } from './subscriptionNavAccess'

describe('isRouteAllowedWithoutSubscription', () => {
  it('allows dashboard and channels', () => {
    expect(isRouteAllowedWithoutSubscription('/dashboard')).toBe(true)
    expect(isRouteAllowedWithoutSubscription('/dashboard/broker/abc')).toBe(true)
    expect(isRouteAllowedWithoutSubscription('/channels')).toBe(true)
  })

  it('allows membership, help, and pricing routes', () => {
    expect(isRouteAllowedWithoutSubscription('/billing')).toBe(true)
    expect(isRouteAllowedWithoutSubscription('/affiliate-program')).toBe(true)
    expect(isRouteAllowedWithoutSubscription('/contact-support')).toBe(true)
    expect(isRouteAllowedWithoutSubscription('/pricing')).toBe(true)
  })

  it('blocks paid app routes', () => {
    expect(isRouteAllowedWithoutSubscription('/brokers')).toBe(false)
    expect(isRouteAllowedWithoutSubscription('/backtest')).toBe(false)
    expect(isRouteAllowedWithoutSubscription('/performance')).toBe(false)
  })
})
