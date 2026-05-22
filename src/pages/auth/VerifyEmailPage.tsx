import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useLocale } from '../../context/LocaleContext'

export function VerifyEmailPage() {
  const { auth } = useLocale()
  const verifyT = auth.verify
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''

  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState('')

  const handleResend = async () => {
    if (!email) return
    setResending(true)
    setError('')
    setResent(false)

    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email,
    })

    if (resendError) {
      setError(resendError.message)
    } else {
      setResent(true)
    }
    setResending(false)
  }

  const subtitle = verifyT.subtitle.replace('{email}', email)

  return (
    <div className="w-full text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-900/20">
        <Mail className="h-8 w-8 text-teal-600 dark:text-teal-400" />
      </div>

      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        {verifyT.heading}
      </h1>

      <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
        {subtitle}
      </p>

      {error ? <Alert variant="error" className="mt-5 py-2.5">{error}</Alert> : null}
      {resent ? <Alert variant="success" className="mt-5 py-2.5">{verifyT.resent}</Alert> : null}

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

        <a
          href="/login"
          className="block text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {verifyT.backToLogin}
        </a>
      </div>
    </div>
  )
}
