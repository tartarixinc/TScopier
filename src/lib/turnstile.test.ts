import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTurnstileEnabled,
  isTurnstileMisconfigured,
  turnstileSiteKey,
} from './turnstile'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Turnstile configuration', () => {
  it('fails closed when the site key is missing in production', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '')

    expect(turnstileSiteKey()).toBe('')
    expect(isTurnstileEnabled()).toBe(false)
    expect(isTurnstileMisconfigured()).toBe(true)
  })

  it('uses a configured environment site key in production', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '  configured-test-site-key  ')

    expect(turnstileSiteKey()).toBe('configured-test-site-key')
    expect(isTurnstileEnabled()).toBe(true)
    expect(isTurnstileMisconfigured()).toBe(false)
  })
})
