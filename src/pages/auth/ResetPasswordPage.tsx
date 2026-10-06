import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { isPasswordRecoveryLink } from '../../lib/isPasswordRecoveryLink'
import { waitForAuthSession } from '../../lib/waitForAuthSession'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { AuthBackHome } from '../../components/auth/AuthBackHome'
import { useLocale } from '../../context/LocaleContext'
import { evaluatePassword } from '../../lib/passwordPolicy'

type PagePhase = 'verifying' | 'ready' | 'invalid' | 'success'

function ResetCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-neutral-200/65 bg-neutral-50/90 p-6 shadow-sm dark:border-neutral-800/55 dark:bg-neutral-900/60 sm:p-8',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const t = auth.resetPassword

  const [phase, setPhase] = useState<PagePhase>('verifying')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const recoveryLink = isPasswordRecoveryLink()

    const markReady = () => {
      if (!cancelled) setPhase('ready')
    }
    const markInvalid = () => {
      if (!cancelled) setPhase('invalid')
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (recoveryLink && session)) {
        markReady()
      }
    })

    void (async () => {
      if (!recoveryLink) {
        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled) return
        if (session) {
          markReady()
        } else {
          markInvalid()
        }
        return
      }

      const session = await waitForAuthSession()
      if (cancelled) return
      if (session) {
        markReady()
      } else {
        markInvalid()
      }
    })()

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(t.passwordMismatch)
      return
    }

    const passwordPolicy = evaluatePassword(password)
    if (!passwordPolicy.ok) {
      setError(
        passwordPolicy.failures.includes('too_short')
          ? t.passwordTooShort
          : t.passwordTooWeak,
      )
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setPhase('success')
    await supabase.auth.signOut()
    window.setTimeout(() => {
      navigate('/login?reset=success', { replace: true })
    }, 1800)
  }

  if (phase === 'verifying') {
    return (
      <div className="w-full">
        <AuthBackHome />
        <ResetCard className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-900/30">
            <Loader2 className="h-7 w-7 animate-spin text-teal-600 dark:text-teal-400" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-2xl">
            {t.verifyingHeading}
          </h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t.verifyingSubtitle}</p>
        </ResetCard>
      </div>
    )
  }

  if (phase === 'invalid') {
    return (
      <div className="w-full">
        <AuthBackHome />
        <ResetCard className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {t.invalidHeading}
          </h1>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{t.invalidSubtitle}</p>
          <Link
            to="/forgot-password"
            className="mt-8 inline-flex items-center justify-center rounded-lg border border-teal-600 bg-teal-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-teal-700 hover:bg-teal-700"
          >
            {t.requestNewLink}
          </Link>
          <p className="mt-4">
            <Link
              to="/login"
              className="text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
            >
              {t.backToLogin}
            </Link>
          </p>
        </ResetCard>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="w-full">
        <AuthBackHome />
        <ResetCard className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-900/30">
            <CheckCircle2 className="h-8 w-8 text-teal-600 dark:text-teal-400" aria-hidden />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {t.successHeading}
          </h1>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{t.successSubtitle}</p>
        </ResetCard>
      </div>
    )
  }

  return (
    <div className="w-full">
      <AuthBackHome />
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-900/30">
          <KeyRound className="h-6 w-6 text-teal-600 dark:text-teal-400" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {t.heading}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t.subtitle}</p>
        </div>
      </div>

      <ResetCard>
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-teal-100 bg-teal-50/70 px-4 py-3 dark:border-teal-900/50 dark:bg-teal-950/30">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
          <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{t.securityNote}</p>
        </div>

        {error ? <Alert variant="error" className="mb-5 py-2.5">{error}</Alert> : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <PasswordInput
            label={t.password}
            placeholder={t.passwordPlaceholder}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            hint={t.passwordHint}
          />

          <PasswordInput
            label={t.confirmPassword}
            placeholder={t.confirmPasswordPlaceholder}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
          />

          <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
            {t.submit}
          </Button>
        </form>
      </ResetCard>

      <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Link
          to="/login"
          className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {t.backToLogin}
        </Link>
      </p>
    </div>
  )
}
