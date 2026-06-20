import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { sendVerificationEmail } from '../../lib/sendVerificationEmail'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { isEmailVerified } from '../../lib/emailVerification'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'

export function VerifyEmailPage() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const verifyT = auth.verify
  const { user, session, signOut } = useAuth()
  const { onboardingCompletedAt, hasProfileRow, emailVerifiedAt, loading: profileLoading, refreshProfile } =
    useUserProfile()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? user?.email ?? ''
  const redirectTo = `${window.location.origin}/auth/confirmed`

  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (profileLoading || !user) return
    void refreshProfile()
  }, [user, profileLoading, refreshProfile])

  useEffect(() => {
    if (profileLoading || !user || !isEmailVerified(user, emailVerifiedAt)) return
    if (hasProfileRow && !onboardingCompletedAt) {
      navigate('/dashboard', { replace: true })
      return
    }
    navigate('/dashboard', { replace: true })
  }, [user, profileLoading, emailVerifiedAt, hasProfileRow, onboardingCompletedAt, navigate])

  const handleResend = async () => {
    if (!email) return
    setResending(true)
    setError('')
    setResent(false)

    const sent = await sendVerificationEmail({
      email,
      accessToken: session?.access_token,
      redirectTo,
    })
    if (!sent.ok) {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: redirectTo },
      })
      if (resendError) {
        setError(sent.error ?? resendError.message)
      } else {
        setResent(true)
      }
    } else {
      setResent(true)
    }
    setResending(false)
  }

  const handleBackToLogin = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  const subtitle = verifyT.subtitle.replace('{email}', email)

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
        {verifyT.instructions ?? 'Open the link in that email to activate your account. You cannot use TScopier until verification is complete.'}
      </p>

      {error ? <Alert variant="error" className="mt-5 py-2.5 text-left">{error}</Alert> : null}
      {resent ? <Alert variant="success" className="mt-5 py-2.5 text-left">{verifyT.resent}</Alert> : null}

      <div className="mt-8 space-y-3">
        <Button
          onClick={handleResend}
          loading={resending}
          variant="secondary"
          className="w-full"
          size="lg"
        >
          {verifyT.resend}
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
