import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { AuthBackHome } from '../../components/auth/AuthBackHome'
import { useLocale } from '../../context/LocaleContext'
import {
  captureReferralFromUrl,
  loadStoredReferralCode,
  referralCodeLooksValid,
} from '../../lib/referralCapture'
import {
  isEmailVerified,
  isUnconfirmedEmailAuthError,
  verifyEmailPath,
} from '../../lib/emailVerification'
import { loadUserProfile } from '../../lib/userProfile'

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

export function AuthPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { auth } = useLocale()
  const loginT = auth.login
  const passwordResetSuccess = searchParams.get('reset') === 'success'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const [storedReferralCode, setStoredReferralCode] = useState<string | null>(null)

  useEffect(() => {
    const fromUrl = captureReferralFromUrl(window.location.search)
    const stored = fromUrl ?? loadStoredReferralCode()
    setStoredReferralCode(stored)
  }, [])

  const handleGoogleSignIn = async () => {
    setError('')
    setGoogleLoading(true)
    const redirectTo = new URL(`${window.location.origin}/dashboard`)
    if (storedReferralCode && referralCodeLooksValid(storedReferralCode)) {
      redirectTo.searchParams.set('ref', storedReferralCode)
    }
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo.toString(),
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
    setLoading(true)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      if (isUnconfirmedEmailAuthError(signInError)) {
        navigate(verifyEmailPath(email))
        setLoading(false)
        return
      }
      setError(signInError.message)
      setLoading(false)
      return
    }

    const profile = data.user ? await loadUserProfile(data.user.id) : null
    if (data.user && !isEmailVerified(data.user, profile?.email_verified_at)) {
      await supabase.auth.signOut()
      navigate(verifyEmailPath(email))
      setLoading(false)
      return
    }

    navigate('/dashboard')
  }

  return (
    <div className="w-full">
      <AuthBackHome />
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        {loginT.heading}
      </h1>
      <p className="mt-2 mb-8 text-sm text-neutral-500 dark:text-neutral-400">
        {loginT.noAccount}{' '}
        <a
          href="/signup"
          className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {loginT.signUpLink}
        </a>
      </p>

      {passwordResetSuccess ? (
        <Alert variant="success" className="mb-5 py-2.5">
          {loginT.passwordResetSuccess}
        </Alert>
      ) : null}
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

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label={loginT.email}
          type="email"
          placeholder={loginT.emailPlaceholder}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="py-2.5"
        />

        <PasswordInput
          label={loginT.password}
          placeholder={loginT.passwordPlaceholder}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />

        <div className="-mt-1 flex justify-end">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
          >
            {loginT.forgotPassword}
          </Link>
        </div>

        <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
          {loginT.submit}
        </Button>
      </form>
    </div>
  )
}
