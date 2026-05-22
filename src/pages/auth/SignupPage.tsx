import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'
import { EMPTY_USER_PROFILE, saveUserProfile } from '../../lib/userProfile'

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
  const { auth } = useLocale()
  const signupT = auth.signup

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')

  const handleGoogleSignIn = async () => {
    setError('')
    setGoogleLoading(true)
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
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

    if (password.length < 6) {
      setError(signupT.passwordTooShort)
      return
    }
    if (password !== confirmPassword) {
      setError(signupT.passwordMismatch)
      return
    }

    setLoading(true)

    const trimmedFirst = firstName.trim()
    const trimmedLast = lastName.trim()
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: trimmedFirst,
          last_name: trimmedLast,
        },
      },
    })
    if (signUpError) {
      setError(signUpError.message)
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
          })
        } catch {
          // Profile save is non-blocking for verification flow
        }

        const confirmUrl = `${window.location.origin}/dashboard`
        const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-verification-email`
        await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${data.session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ confirmUrl }),
        }).catch(() => {})
      }
    }

    navigate(`/verify-email?email=${encodeURIComponent(email)}`)
  }

  return (
    <div className="w-full">
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

      <form onSubmit={handleSubmit} className="space-y-4">
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
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          hint={signupT.passwordHint}
        />

        <PasswordInput
          label={signupT.confirmPassword}
          placeholder={signupT.confirmPasswordPlaceholder}
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
        />

        <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
          {signupT.submit}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
        {signupT.terms}
      </p>
    </div>
  )
}


export { SignupPage }