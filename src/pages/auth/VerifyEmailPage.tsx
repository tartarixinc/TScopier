import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Mail } from 'lucide-react'
import {
  clearVerificationEmailCooldown,
  readVerificationEmailCooldownSeconds,
  sendVerificationEmail,
  startVerificationEmailCooldown,
} from '../../lib/sendVerificationEmail'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { isEmailVerified } from '../../lib/emailVerification'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'
import { postAuthAppPath } from '../../lib/pendingPlanSelection'
import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/auth/TurnstileWidget'
import { isTurnstileEnabled } from '../../lib/turnstile'

export function VerifyEmailPage() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const verifyT = auth.verify
  const { user, session, signOut } = useAuth()
  const { emailVerifiedAt, loading: profileLoading } = useUserProfile()
  const [searchParams] = useSearchParams()
  // Prefer the query string so the subtitle does not flash when the session clears.
  const email = (searchParams.get('email') ?? '').trim() || user?.email || ''
  const redirectTo = `${window.location.origin}/auth/confirmed`

  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileWidgetHandle>(null)
  const captchaRequired = isTurnstileEnabled()
  const [cooldownSeconds, setCooldownSeconds] = useState(() =>
    readVerificationEmailCooldownSeconds(email),
  )

  useEffect(() => {
    setCooldownSeconds(readVerificationEmailCooldownSeconds(email))
  }, [email])

  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const id = window.setInterval(() => {
      const remaining = readVerificationEmailCooldownSeconds(email)
      setCooldownSeconds(remaining)
      if (remaining <= 0) clearVerificationEmailCooldown(email)
    }, 1000)
    return () => window.clearInterval(id)
  }, [email, cooldownSeconds <= 0 ? 0 : 1])

  // UserProfileProvider already loads the profile. Do not call refreshProfile here —
  // tying it to profileLoading caused an infinite load/refresh loop and page flicker
  // whenever an unverified session landed on this page.
  useEffect(() => {
    if (profileLoading || !user || !isEmailVerified(user, emailVerifiedAt)) return
    navigate(postAuthAppPath(), { replace: true })
  }, [user, profileLoading, emailVerifiedAt, navigate])

  const handleResend = async () => {
    if (!email || resending || cooldownSeconds > 0) return
    if (captchaRequired && !captchaToken) {
      setError(auth.oauth.captchaRequired)
      return
    }
    setResending(true)
    setError('')
    setResent(false)

    const sent = await sendVerificationEmail({
      email,
      accessToken: session?.access_token,
      redirectTo,
      captchaToken,
    })

    turnstileRef.current?.reset()
    setCaptchaToken(null)

    if (!sent.ok) {
      if (sent.retryAfterSeconds) {
        startVerificationEmailCooldown(email, sent.retryAfterSeconds)
        setCooldownSeconds(sent.retryAfterSeconds)
        const template = verifyT.resendCooldown
          ?? 'Please wait {seconds}s before requesting another email.'
        setError(template.replace('{seconds}', String(sent.retryAfterSeconds)))
      } else {
        setError(sent.error)
      }
      setResending(false)
      return
    }

    setCooldownSeconds(sent.cooldownSeconds)
    setResent(true)
    setResending(false)
  }

  const handleBackToLogin = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  const subtitle = verifyT.subtitle.replace('{email}', email)
  const resendLabel = cooldownSeconds > 0
    ? (verifyT.resendIn ?? 'Resend in {seconds}s').replace(
      '{seconds}',
      String(cooldownSeconds),
    )
    : verifyT.resend

  return (
    <div className="w-full py-4 text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-950/40">
        <Mail className="h-8 w-8 text-amber-600 dark:text-amber-400" />
      </div>

      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        {verifyT.heading}
      </h1>

      <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{subtitle}</p>
      <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        {verifyT.instructions ?? 'Open the link in that email to activate your account. You cannot use UniCopier until verification is complete.'}
      </p>

      {error ? <Alert variant="error" className="mt-5 py-2.5 text-left">{error}</Alert> : null}
      {resent ? <Alert variant="success" className="mt-5 py-2.5 text-left">{verifyT.resent}</Alert> : null}

      <div className="mt-8 space-y-3">
        <TurnstileWidget
          ref={turnstileRef}
          className="flex justify-center"
          onToken={setCaptchaToken}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
        />

        <Button
          onClick={() => void handleResend()}
          loading={resending}
          disabled={cooldownSeconds > 0 || (captchaRequired && !captchaToken)}
          variant="secondary"
          className="w-full"
          size="lg"
        >
          {resendLabel}
        </Button>

        <button
          type="button"
          onClick={() => void handleBackToLogin()}
          className="block w-full text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {verifyT.backToLogin}
        </button>
      </div>
    </div>
  )
}
