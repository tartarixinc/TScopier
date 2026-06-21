import type { User } from '@supabase/supabase-js'

/** OAuth IdPs (Google, etc.) verify email before we receive the user. */
export function isOAuthUser(user: User | null | undefined): boolean {
  if (!user) return false
  const providers = (user.app_metadata?.providers as string[] | undefined) ?? []
  if (providers.some(p => p !== 'email')) return true
  const provider = user.app_metadata?.provider as string | undefined
  return Boolean(provider && provider !== 'email')
}

/**
 * True when the user may use the app.
 * Email/password signups require profile.email_verified_at (set only after clicking the verification link).
 */
export function isEmailVerified(
  user: User | null | undefined,
  emailVerifiedAt?: string | null,
): boolean {
  if (!user) return false
  if (isOAuthUser(user)) {
    return Boolean(user.email_confirmed_at)
  }
  return Boolean(emailVerifiedAt)
}

export function verifyEmailPath(email: string | null | undefined): string {
  const q = email?.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''
  return `/verify-email${q}`
}

/** Supabase may block sign-in or return a user without a confirmed email. */
export function isUnconfirmedEmailAuthError(error: { message?: string; code?: string }): boolean {
  const code = (error.code ?? '').toLowerCase()
  const message = (error.message ?? '').toLowerCase()
  return (
    code === 'email_not_confirmed'
    || message.includes('email not confirmed')
    || message.includes('email not verified')
  )
}

/** Routes reachable while logged in but email is not verified yet. */
export const EMAIL_VERIFICATION_EXEMPT_PATHS = new Set([
  '/verify-email',
  '/auth/confirmed',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
])
