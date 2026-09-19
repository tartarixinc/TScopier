import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { AlertCircle, Check, Circle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { AuthBackHome } from '../../components/auth/AuthBackHome'
import { useLocale } from '../../context/LocaleContext'
import { EMPTY_USER_PROFILE, saveUserProfile } from '../../lib/userProfile'
import { sendVerificationEmail } from '../../lib/sendVerificationEmail'
import {
  captureReferralFromUrl,
  loadStoredReferralCode,
  normalizeReferralCode,
  referralCodeLooksValid,
} from '../../lib/referralCapture'
import { isEmailVerified } from '../../lib/emailVerification'
import { marketingUrl } from '../../lib/site'
import {
  capturePendingPlanFromUrl,
  postAuthAppPath,
} from '../../lib/pendingPlanSelection'
import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/auth/TurnstileWidget'
import { isTurnstileEnabled, isTurnstileMisconfigured } from '../../lib/turnstile'
import {
  evaluateSignupEmail,
  signupErrorPolicyCode,
  signupPolicyMessage,
} from '../../lib/signupEmailPolicy'
import { evaluatePassword } from '../../lib/passwordPolicy'
import {
  isCreateAccountDisabled,
  passwordRequirementStatuses,
  signupUnmetConditions,
  type SignupUnmetCondition,
} from '../../lib/signupValidation'

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

export function SignupPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { auth } = useLocale()
  const signupT = auth.signup

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [referralCode, setReferralCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [passwordInteracted, setPasswordInteracted] = useState(false)
  const [formInteracted, setFormInteracted] = useState(false)
  const turnstileRef = useRef<TurnstileWidgetHandle>(null)
  const captchaRequired = isTurnstileEnabled()
  const captchaMisconfigured = isTurnstileMisconfigured()
  const validationInput = {
    firstName,
    lastName,
    email,
    password,
    confirmPassword,
    captchaRequired,
    captchaToken,
    captchaMisconfigured,
  }
  const passwordRequirements = passwordRequirementStatuses(password)
  const unmetConditions = signupUnmetConditions(validationInput)
  const showValidationGuidance = formInteracted || passwordInteracted

  const unmetConditionMessage = (condition: SignupUnmetCondition): string => {
    switch (condition) {
      case 'first_name_required':
        return signupT.firstName + ' is required.'
      case 'last_name_required':
        return signupT.lastName + ' is required.'
      case 'email_required':
        return signupT.email + ' is required.'
      case 'email_invalid':
        return 'Enter a valid email address.'
      case 'email_blocked':
        return signupT.emailNotAllowed
      case 'email_disposable':
        return signupT.disposableEmailNotAllowed
      case 'password_incomplete':
        return 'Complete all password requirements.'
      case 'confirm_password_required':
        return signupT.confirmPassword + ' is required.'
      case 'password_mismatch':
        return signupT.passwordMismatch
      case 'captcha_required':
        return auth.oauth.captchaRequired
      case 'captcha_misconfigured':
        return 'Signup protection is misconfigured. Please try again later.'
    }
  }

  useEffect(() => {
    const fromUrl = captureReferralFromUrl(location.search)
    const stored = fromUrl ?? loadStoredReferralCode()
    if (stored) setReferralCode(stored)
    capturePendingPlanFromUrl(location.search)
  }, [location.search])

  const handleGoogleSignIn = async () => {
    setError('')
    setGoogleLoading(true)
    const normalizedRef = normalizeReferralCode(referralCode)
    capturePendingPlanFromUrl(location.search)
    const redirectUrl = new URL(`${window.location.origin}${postAuthAppPath()}`)
    if (referralCodeLooksValid(normalizedRef)) {
      redirectUrl.searchParams.set('ref', normalizedRef)
    }
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl.toString(),
      },
    })
    if (oauthError) {
      setError(oauthError.message)
      setGoogleLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(signupT.passwordMismatch)
      return
    }

    const passwordPolicy = evaluatePassword(password)
    if (!passwordPolicy.ok) {
      setError(
        passwordPolicy.failures.includes('too_short')
          ? signupT.passwordTooShort
          : signupT.passwordTooWeak,
      )
      return
    }

    if (captchaMisconfigured) {
      setError('Signup protection is misconfigured. Please try again later.')
      return
    }

    if (captchaRequired && !captchaToken) {
      setError(auth.oauth.captchaRequired)
      return
    }

    const emailPolicy = evaluateSignupEmail(email)
    if (!emailPolicy.allowed) {
      setError(signupPolicyMessage(emailPolicy.code, {
        emailNotAllowed: signupT.emailNotAllowed,
        disposableEmailNotAllowed: signupT.disposableEmailNotAllowed,
      }))
      return
    }

    setLoading(true)

    const trimmedFirst = firstName.trim()
    const trimmedLast = lastName.trim()
    const normalizedRef = normalizeReferralCode(referralCode)
    const redirectUrl = new URL(`${window.location.origin}/auth/confirmed`)
    if (referralCodeLooksValid(normalizedRef)) {
      redirectUrl.searchParams.set('ref', normalizedRef)
    }
    const redirectTo = redirectUrl.toString()
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectTo,
        captchaToken: captchaToken ?? undefined,
        data: {
          first_name: trimmedFirst,
          last_name: trimmedLast,
          referral_code: referralCodeLooksValid(normalizedRef) ? normalizedRef : null,
        },
      },
    })
    if (signUpError) {
      const policyCode = signupErrorPolicyCode(signUpError.message)
      setError(
        policyCode
          ? signupPolicyMessage(policyCode, {
              emailNotAllowed: signupT.emailNotAllowed,
              disposableEmailNotAllowed: signupT.disposableEmailNotAllowed,
            })
          : signUpError.message,
      )
      turnstileRef.current?.reset()
      setCaptchaToken(null)
      setLoading(false)
      return
    }

    if (data.user) {
      const displayName = [trimmedFirst, trimmedLast].filter(Boolean).join(' ')
      if (data.session) {
        try {
          await saveUserProfile(data.user.id, {
            ...EMPTY_USER_PROFILE,
            first_name: trimmedFirst,
            last_name: trimmedLast,
            display_name: displayName,
            username: email.split('@')[0] ?? '',
            onboarding_completed_at: null,
          })
        } catch {
          // Profile save is non-blocking for verification flow
        }

      }

      const sent = await sendVerificationEmail({
        email: data.user.email ?? email,
        accessToken: data.session?.access_token,
        redirectTo,
        captchaToken,
      })
      if (!sent.ok) {
        // Do not treat rate_limited/cooldown as success — that fakes "email sent"
        // when Resend was never called (e.g. global flood cap).
        setError(sent.error)
        turnstileRef.current?.reset()
        setCaptchaToken(null)
        setLoading(false)
        return
      }
    }

    if (data.user && !isEmailVerified(data.user, null)) {
      await supabase.auth.signOut()
    }

    navigate(`/verify-email?email=${encodeURIComponent(email)}`)
  }

  return (
    <div className="w-full">
      <AuthBackHome />
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        {signupT.heading}
      </h1>
      <p className="mt-2 mb-8 text-sm text-neutral-500 dark:text-neutral-400">
        {signupT.hasAccount}{' '}
        <a
          href="/login"
          className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {signupT.signInLink}
        </a>
      </p>

      {error ? <Alert variant="error" className="mb-5 py-2.5">{error}</Alert> : null}

      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={googleLoading || loading}
        className={clsx(
          'flex w-full items-center justify-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors',
          'hover:bg-neutral-50 active:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60',
          'dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-750 dark:active:bg-neutral-700',
        )}
      >
        <GoogleIcon className="h-5 w-5" />
        {auth.oauth.continueWithGoogle}
      </button>

      <div className="relative my-5">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-neutral-200 dark:border-neutral-700" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-white px-3 text-neutral-400 dark:bg-neutral-950 dark:text-neutral-500">
            {auth.oauth.orDivider}
          </span>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        onChange={() => setFormInteracted(true)}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={signupT.firstName}
            type="text"
            placeholder={signupT.firstNamePlaceholder}
            value={firstName}
            onChange={e => setFirstName(e.target.value)}
            required
            autoComplete="given-name"
            className="py-2.5"
          />
          <Input
            label={signupT.lastName}
            type="text"
            placeholder={signupT.lastNamePlaceholder}
            value={lastName}
            onChange={e => setLastName(e.target.value)}
            required
            autoComplete="family-name"
            className="py-2.5"
          />
        </div>

        <Input
          label={signupT.email}
          type="email"
          placeholder={signupT.emailPlaceholder}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="py-2.5"
        />

        <PasswordInput
          label={signupT.password}
          placeholder={signupT.passwordPlaceholder}
          value={password}
          onFocus={() => setPasswordInteracted(true)}
          onChange={e => {
            setPasswordInteracted(true)
            setPassword(e.target.value)
          }}
          required
          autoComplete="new-password"
          hint={passwordInteracted ? undefined : signupT.passwordHint}
        />

        {passwordInteracted ? (
          <div
            aria-label="Password requirements"
            className="-mt-1 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900/70"
          >
            <p className="mb-2 text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Password requirements
            </p>
            <ul className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2">
              {passwordRequirements.map(requirement => (
                <li
                  key={requirement.id}
                  className={clsx(
                    'flex items-center gap-1.5 text-xs',
                    requirement.satisfied
                      ? 'text-teal-700 dark:text-teal-300'
                      : 'text-neutral-500 dark:text-neutral-400',
                  )}
                >
                  {requirement.satisfied ? (
                    <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="sr-only">
                    {requirement.satisfied ? 'Satisfied: ' : 'Incomplete: '}
                  </span>
                  <span>{requirement.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <PasswordInput
          label={signupT.confirmPassword}
          placeholder={signupT.confirmPasswordPlaceholder}
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
        />

        <Input
          label="Referral code (optional)"
          type="text"
          placeholder="Enter referral code"
          value={referralCode}
          onChange={e => setReferralCode(normalizeReferralCode(e.target.value))}
        />

        <TurnstileWidget
          ref={turnstileRef}
          className="flex justify-center"
          onToken={setCaptchaToken}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
        />

        {captchaMisconfigured ? (
          <Alert variant="error" className="py-2.5">
            Signup protection is misconfigured. Please try again later.
          </Alert>
        ) : null}

        {showValidationGuidance && unmetConditions.length > 0 ? (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-neutral-700 dark:border-amber-900/70 dark:bg-amber-950/20 dark:text-neutral-300"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  Complete the following to create your account:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-neutral-600 dark:text-neutral-400">
                  {unmetConditions.map(condition => (
                    <li key={condition}>{unmetConditionMessage(condition)}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        <Button
          type="submit"
          loading={loading}
          disabled={isCreateAccountDisabled(validationInput)}
          className="w-full !mt-6"
          size="lg"
        >
          {signupT.submit}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {signupT.terms.prefix}{' '}
        <a
          href={marketingUrl('/terms')}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-600 hover:underline dark:text-teal-400"
        >
          {signupT.terms.termsOfService}
        </a>
        {signupT.terms.conjunction}
        <a
          href={marketingUrl('/privacy')}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-600 hover:underline dark:text-teal-400"
        >
          {signupT.terms.privacyPolicy}
        </a>
      </p>
    </div>
  )
}
