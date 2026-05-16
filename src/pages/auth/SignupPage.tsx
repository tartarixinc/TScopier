import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { AuthFormShell } from '../../components/auth/AuthFormShell'
import { PasswordInput } from '../../components/auth/PasswordInput'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

export function SignupPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
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
      title="Create your account"
      subtitle="Set up in minutes — connect Telegram, link a broker, and start copying signals."
      footer={
        <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300">
            Sign in
          </Link>
        </p>
      }
    >
      {error ? <Alert variant="error" className="mb-5 py-2.5">{error}</Alert> : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
          autoFocus
          className="py-2.5"
        />
        <PasswordInput
          label="Password"
          placeholder="Choose a password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          hint="At least 6 characters"
        />
        <Button type="submit" loading={loading} className="w-full !mt-6" size="lg">
          Create account
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-neutral-400 dark:text-neutral-500 leading-relaxed">
        By creating an account, you agree to use TSCopier responsibly and comply with your broker&apos;s terms.
      </p>
    </AuthFormShell>
  )
}
