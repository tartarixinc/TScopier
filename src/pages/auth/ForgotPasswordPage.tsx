import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { authRedirectUrl } from '../../lib/authRedirect'
import { sendPasswordResetEmail } from '../../lib/sendPasswordResetEmail'
import { Input } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { AuthBackHome } from '../../components/auth/AuthBackHome'
import { useLocale } from '../../context/LocaleContext'
import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/auth/TurnstileWidget'
import { isTurnstileEnabled, isTurnstileMisconfigured } from '../../lib/turnstile'

export function ForgotPasswordPage() {
  const { auth } = useLocale()
  const t = auth.forgotPassword

  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileWidgetHandle>(null)
  const captchaRequired = isTurnstileEnabled()
  const captchaMisconfigured = isTurnstileMisconfigured()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (captchaMisconfigured) {
      setError('Password reset protection is misconfigured. Please try again later.')
      return
    }
    if (captchaRequired && !captchaToken) {
      setError(auth.oauth.captchaRequired)
      return
    }
    setLoading(true)

    const result = await sendPasswordResetEmail({
      email: email.trim(),
      redirectTo: authRedirectUrl('/reset-password'),
      captchaToken,
    })

    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? t.sendError)
      turnstileRef.current?.reset()
      setCaptchaToken(null)
      return
    }

    setSent(true)
  }

  if (sent) {
    const subtitle = t.sentSubtitle.replace('{email}', email.trim())

    return (
      <div className="w-full">
        <AuthBackHome />
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-900/20">
            <Mail className="h-8 w-8 text-green-400 dark:text-green-400" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {t.sentHeading}
          </h1>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{subtitle}</p>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t.sentHint}</p>
          <Link
            to="/login"
            className="mt-8 inline-block text-sm font-medium text-green-400 hover:text-green-500 dark:text-green-400 dark:hover:text-teal-300"
          >
            {t.backToLogin}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <AuthBackHome />
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        {t.heading}
      </h1>
      <p className="mt-2 mb-8 text-sm text-neutral-500 dark:text-neutral-400">{t.subtitle}</p>

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
          className="py-2.5"
        />

        <TurnstileWidget
          ref={turnstileRef}
          className="flex justify-center"
          onToken={setCaptchaToken}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
        />

        <Button
          type="submit"
          loading={loading}
          disabled={captchaMisconfigured || (captchaRequired && !captchaToken)}
          className="w-full !mt-6"
          size="lg"
        >
          {t.submit}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Link
          to="/login"
          className="font-medium text-green-400 hover:text-green-500 dark:text-green-400 dark:hover:text-teal-300"
        >
          {t.backToLogin}
        </Link>
      </p>
    </div>
  )
}
