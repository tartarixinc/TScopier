import { useRef, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { TurnstileWidget, type TurnstileWidgetHandle } from '../components/TurnstileWidget'
import { isTurnstileEnabled, isTurnstileMisconfigured } from '../lib/turnstile'

export function LoginPage() {
  const { user, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileWidgetHandle>(null)
  const captchaRequired = isTurnstileEnabled()
  const captchaMisconfigured = isTurnstileMisconfigured()

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (captchaMisconfigured) {
      setError('Login protection is misconfigured. Please try again later.')
      return
    }
    if (captchaRequired && !captchaToken) {
      setError('Please complete the captcha challenge.')
      return
    }
    setSubmitting(true)
    try {
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
        options: { captchaToken: captchaToken ?? undefined },
      })
      if (authErr) {
        setError(authErr.message)
        // Tokens are single-use: clear and reset so the next attempt gets a fresh one.
        turnstileRef.current?.reset()
        setCaptchaToken(null)
      }
    } catch {
      setError('Something went wrong. Please try again.')
      turnstileRef.current?.reset()
      setCaptchaToken(null)
    } finally {
      setSubmitting(false)
    }
  }

  if (!loading && user) return <Navigate to="/" replace />

  return (
    <section className="grid min-h-screen place-items-center bg-neutral-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6"
      >
        <img
          src="/uni-support-logo.png"
          alt="uni Support"
          className="h-9 w-auto rounded-md"
          draggable={false}
        />
        <h1 className="mt-4 text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">Support agents and admins only.</p>
        <div className="mt-4 space-y-3">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            required
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            required
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
          />
          <TurnstileWidget
            ref={turnstileRef}
            onToken={token => {
              setCaptchaToken(token)
              setError('')
            }}
            onExpire={() => {
              setCaptchaToken(null)
              setError('Captcha expired. Please solve it again.')
            }}
            onError={() => {
              setCaptchaToken(null)
              setError('Captcha could not load. Please refresh the page or try again later.')
            }}
            className="flex justify-center"
          />
          {error ? <p className="text-sm text-red-500">{error}</p> : null}
          <button
            type="submit"
            disabled={submitting || captchaMisconfigured || (captchaRequired && !captchaToken)}
            className="w-full rounded-lg bg-green-400 py-2.5 text-sm font-medium text-neutral-950"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </section>
  )
}
