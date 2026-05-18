import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'
import { EMPTY_USER_PROFILE, saveUserProfile } from '../../lib/userProfile'

type AuthMode = 'login' | 'signup'

export function AuthPage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { auth } = useLocale()
  const loginT = auth.login
  const signupT = auth.signup

  const [mode, setMode] = useState<AuthMode>(() => (pathname === '/signup' ? 'signup' : 'login'))
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const isLogin = mode === 'login'
  const t = isLogin ? loginT : signupT

  const switchMode = (next: AuthMode) => {
    if (next === mode) return
    setMode(next)
    setError('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isLogin) {
      if (password.length < 6) {
        setError(signupT.passwordTooShort)
        return
      }
      if (password !== confirmPassword) {
        setError(signupT.passwordMismatch)
        return
      }
    }

    setLoading(true)

    if (isLogin) {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) {
        setError(signInError.message)
        setLoading(false)
        return
      }
    } else {
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

      if (data.user && data.session) {
        const displayName = [trimmedFirst, trimmedLast].filter(Boolean).join(' ')
        try {
          await saveUserProfile(data.user.id, {
            ...EMPTY_USER_PROFILE,
            first_name: trimmedFirst,
            last_name: trimmedLast,
            display_name: displayName,
            username: email.split('@')[0] ?? '',
          })
        } catch (profileError) {
          setError(profileError instanceof Error ? profileError.message : 'Failed to save profile')
          setLoading(false)
          return
        }
      }
    }

    navigate('/dashboard')
  }

  return (
    <div className="w-full">
      <nav
        className="mb-8 flex rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800/80"
        aria-label="Authentication"
      >
        <button
          type="button"
          onClick={() => switchMode('login')}
          className={clsx(
            'flex-1 rounded-lg py-2.5 text-center text-sm font-medium transition-all',
            isLogin
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-50'
              : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200',
          )}
          aria-selected={isLogin}
          role="tab"
        >
          {auth.nav.signIn}
        </button>
        <button
          type="button"
          onClick={() => switchMode('signup')}
          className={clsx(
            'flex-1 rounded-lg py-2.5 text-center text-sm font-medium transition-all',
            !isLogin
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-50'
              : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200',
          )}
          aria-selected={!isLogin}
          role="tab"
        >
          {auth.nav.createAccount}
        </button>
      </nav>

      <div className={clsx(isLogin ? 'min-h-[21rem]' : 'min-h-[36rem]')}>
        {error ? <Alert variant="error" className="mb-5 py-2.5">{error}</Alert> : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin ? (
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
          ) : null}

          <Input
            label={t.email}
            type="email"
            placeholder={t.emailPlaceholder}
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="py-2.5"
          />

          <div className={clsx(!isLogin && 'min-h-[5.75rem]')}>
            <PasswordInput
              label={t.password}
              placeholder={t.passwordPlaceholder}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              hint={isLogin ? undefined : signupT.passwordHint}
            />
          </div>

          {!isLogin ? (
            <PasswordInput
              label={signupT.confirmPassword}
              placeholder={signupT.confirmPasswordPlaceholder}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          ) : null}

          <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
            {t.submit}
          </Button>
        </form>

        <p
          className={clsx(
            'mt-4 min-h-[2.5rem] text-center text-xs leading-relaxed text-neutral-400 dark:text-neutral-500',
            isLogin && 'invisible',
          )}
          aria-hidden={isLogin}
        >
          {signupT.terms}
        </p>
      </div>
    </div>
  )
}
