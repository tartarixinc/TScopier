import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { AuthFormShell } from '../../components/auth/AuthFormShell'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'

export function SignupPage() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const t = auth.signup
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError(t.passwordTooShort)
      return
    }

    setLoading(true)
    const { error: signUpError } = await supabase.auth.signUp({ email, password })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    navigate('/dashboard')
  }

  return (
    <AuthFormShell
      title={t.title}
      subtitle={t.subtitle}
      footer={
        <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t.footerPrompt}{' '}
          <Link to="/login" className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300">
            {t.footerLink}
          </Link>
        </p>
      }
    >
      {error ? <Alert variant="error" className="mb-5 py-2.5">{error}</Alert> : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label={t.email}
          type="email"
          placeholder={t.emailPlaceholder}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
          autoFocus
          className="py-2.5"
        />
        <PasswordInput
          label={t.password}
          placeholder={t.passwordPlaceholder}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          hint={t.passwordHint}
        />
        <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
          {t.submit}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-neutral-400 dark:text-neutral-500 leading-relaxed">
        {t.terms}
      </p>
    </AuthFormShell>
  )
}
