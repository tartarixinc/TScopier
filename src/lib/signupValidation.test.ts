import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isCreateAccountDisabled,
  passwordRequirementStatuses,
  signupUnmetConditions,
  type SignupValidationInput,
} from './signupValidation'

const valid: SignupValidationInput = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.dev',
  password: 'Trade1!',
  confirmPassword: 'Trade1!',
  captchaRequired: true,
  captchaToken: 'verified',
  captchaMisconfigured: false,
}

describe('signup validation explanations', () => {
  it('shows a missing password requirement as incomplete', () => {
    const special = passwordRequirementStatuses('Trade12')
      .find(requirement => requirement.id === 'special')
    expect(special).toMatchObject({ satisfied: false })
  })

  it('marks a password requirement satisfied while typing', () => {
    const before = passwordRequirementStatuses('Trade12')
      .find(requirement => requirement.id === 'special')
    const after = passwordRequirementStatuses('Trade12!')
      .find(requirement => requirement.id === 'special')
    expect(before?.satisfied).toBe(false)
    expect(after?.satisfied).toBe(true)
  })

  it('identifies missing CAPTCHA verification', () => {
    expect(signupUnmetConditions({ ...valid, captchaToken: null }))
      .toEqual(['captcha_required'])
  })

  it('identifies a missing required field', () => {
    expect(signupUnmetConditions({ ...valid, firstName: '' }))
      .toEqual(['first_name_required'])
  })

  it('returns every currently unmet condition', () => {
    expect(signupUnmetConditions({
      ...valid,
      firstName: '',
      email: '',
      password: 'lowercase',
      confirmPassword: '',
      captchaToken: null,
    })).toEqual([
      'first_name_required',
      'email_required',
      'password_incomplete',
      'confirm_password_required',
      'captcha_required',
    ])
  })

  it('clears warnings and preserves the existing enabled-button behavior', () => {
    expect(signupUnmetConditions(valid)).toEqual([])
    expect(isCreateAccountDisabled(valid)).toBe(false)
  })

  it('preserves existing gating without adding required fields to disabled state', () => {
    expect(isCreateAccountDisabled({ ...valid, firstName: '' })).toBe(false)
    expect(isCreateAccountDisabled({ ...valid, captchaToken: null })).toBe(true)
    expect(isCreateAccountDisabled({ ...valid, password: 'Trade12', confirmPassword: 'Trade12' }))
      .toBe(true)
    expect(isCreateAccountDisabled({ ...valid, confirmPassword: 'Different1!' })).toBe(true)
  })
})

describe('existing signup submission flow', () => {
  it('keeps the existing Supabase signup, verification email, sign-out, and navigation sequence', () => {
    const source = readFileSync(
      new URL('../pages/auth/SignupPage.tsx', import.meta.url),
      'utf8',
    )
    const signupAt = source.indexOf('await supabase.auth.signUp({')
    const verificationAt = source.indexOf('await sendVerificationEmail({')
    const signOutAt = source.indexOf('await supabase.auth.signOut()')
    const navigateAt = source.indexOf('navigate(`/verify-email?email=')

    expect(signupAt).toBeGreaterThan(-1)
    expect(source).toContain('captchaToken: captchaToken ?? undefined')
    expect(source).toContain('first_name: trimmedFirst')
    expect(source).toContain('last_name: trimmedLast')
    expect(verificationAt).toBeGreaterThan(signupAt)
    expect(signOutAt).toBeGreaterThan(verificationAt)
    expect(navigateAt).toBeGreaterThan(signOutAt)
  })
})
