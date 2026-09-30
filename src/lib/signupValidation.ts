import {
  evaluatePassword,
  MIN_PASSWORD_LENGTH,
  type PasswordPolicyFailure,
} from './passwordPolicy'
import { evaluateSignupEmail, type SignupEmailPolicyCode } from './signupEmailPolicy'

export type PasswordRequirementId =
  | 'minimum_length'
  | 'uppercase'
  | 'lowercase'
  | 'number'
  | 'special'
  | 'not_common'

export type PasswordRequirementStatus = {
  id: PasswordRequirementId
  label: string
  satisfied: boolean
}

const FAILURE_BY_REQUIREMENT: Record<PasswordRequirementId, PasswordPolicyFailure> = {
  minimum_length: 'too_short',
  uppercase: 'missing_uppercase',
  lowercase: 'missing_lowercase',
  number: 'missing_number',
  special: 'missing_special',
  not_common: 'common_password',
}

const REQUIREMENT_LABELS: Record<PasswordRequirementId, string> = {
  minimum_length: 'At least ' + MIN_PASSWORD_LENGTH + ' characters',
  uppercase: 'One uppercase letter',
  lowercase: 'One lowercase letter',
  number: 'One number',
  special: 'One symbol or special character',
  not_common: 'Not a commonly used password',
}

export function passwordRequirementStatuses(password: string): PasswordRequirementStatus[] {
  const result = evaluatePassword(password)
  const failures = new Set<PasswordPolicyFailure>(result.ok ? [] : result.failures)
  return (Object.keys(REQUIREMENT_LABELS) as PasswordRequirementId[]).map(id => ({
    id,
    label: REQUIREMENT_LABELS[id],
    // Avoid showing an untouched password as having already passed a requirement.
    satisfied: password.length > 0 && !failures.has(FAILURE_BY_REQUIREMENT[id]),
  }))
}

export type SignupUnmetCondition =
  | 'first_name_required'
  | 'last_name_required'
  | 'email_required'
  | 'email_invalid'
  | 'email_blocked'
  | 'email_disposable'
  | 'password_incomplete'
  | 'confirm_password_required'
  | 'password_mismatch'
  | 'captcha_required'
  | 'captcha_misconfigured'

export type SignupValidationInput = {
  firstName: string
  lastName: string
  email: string
  password: string
  confirmPassword: string
  captchaRequired: boolean
  captchaToken: string | null
  captchaMisconfigured: boolean
}

function emailCondition(code: SignupEmailPolicyCode): SignupUnmetCondition {
  if (code === 'disposable_domain') return 'email_disposable'
  if (code === 'blocked_email') return 'email_blocked'
  return 'email_invalid'
}

export function signupUnmetConditions(input: SignupValidationInput): SignupUnmetCondition[] {
  const unmet: SignupUnmetCondition[] = []
  if (input.firstName.length === 0) unmet.push('first_name_required')
  if (input.lastName.length === 0) unmet.push('last_name_required')
  if (input.email.length === 0) {
    unmet.push('email_required')
  } else {
    const emailPolicy = evaluateSignupEmail(input.email)
    if (!emailPolicy.allowed) unmet.push(emailCondition(emailPolicy.code))
  }
  if (!evaluatePassword(input.password).ok) unmet.push('password_incomplete')
  if (input.confirmPassword.length === 0) {
    unmet.push('confirm_password_required')
  } else if (input.password !== input.confirmPassword) {
    unmet.push('password_mismatch')
  }
  if (input.captchaMisconfigured) {
    unmet.push('captcha_misconfigured')
  } else if (input.captchaRequired && !input.captchaToken) {
    unmet.push('captcha_required')
  }
  return unmet
}

/** Mirrors the pre-existing disabled expression exactly. */
export function isCreateAccountDisabled(input: SignupValidationInput): boolean {
  return (
    input.captchaMisconfigured
    || (input.captchaRequired && !input.captchaToken)
    || !evaluatePassword(input.password).ok
    || input.password !== input.confirmPassword
  )
}
