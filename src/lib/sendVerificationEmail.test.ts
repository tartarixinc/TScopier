import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendVerificationEmail } from './sendVerificationEmail'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendVerificationEmail', () => {
  it('returns an error when the request cannot complete', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))

    await expect(sendVerificationEmail({ email: 'user@example.test' })).resolves.toEqual({
      ok: false,
      code: 'error',
      error: 'Could not request a verification email. Please try again.',
    })
  })
})