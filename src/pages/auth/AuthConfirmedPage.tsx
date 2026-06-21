import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { isEmailVerified } from '../../lib/emailVerification'
import { markEmailVerified } from '../../lib/markEmailVerified'
import { loadUserProfile } from '../../lib/userProfile'
import { waitForAuthSession } from '../../lib/waitForAuthSession'
import { useLocale } from '../../context/LocaleContext'

/** Landing route after the user clicks the verification link in their email. */
export function AuthConfirmedPage() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const verifyT = auth.verify
  const { user } = useAuth()
  const { refreshProfile } = useUserProfile()
  const [phase, setPhase] = useState<'waiting' | 'confirming' | 'error'>('waiting')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      setPhase('waiting')
      const session = await waitForAuthSession()
      if (cancelled) return

      const activeUser = session?.user ?? user
      if (!activeUser) {
        setPhase('error')
        setError(
          verifyT.confirmLinkExpired
          ?? 'This confirmation link expired or was already used. Sign in or request a new email.',
        )
        return
      }

      setPhase('confirming')

      for (let attempt = 0; attempt < 12; attempt++) {
        if (cancelled) return
        if (activeUser.email_confirmed_at) {
          try {
            await markEmailVerified()
          } catch {
            /* DB trigger may have already synced */
          }
        }
        const row = await loadUserProfile(activeUser.id)
        await refreshProfile()
        if (isEmailVerified(activeUser, row?.email_verified_at)) {
          navigate('/dashboard', { replace: true })
          return
        }
        await new Promise(r => setTimeout(r, 400))
      }

      if (!cancelled) {
        setPhase('error')
        setError(
          verifyT.confirmPending
          ?? 'Verification is still processing. Check your email for the latest link.',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user, navigate, refreshProfile, verifyT.confirmPending, verifyT.confirmLinkExpired])

  if (phase === 'error') {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <p className="text-sm text-amber-700 dark:text-amber-300">{error}</p>
        <Link
          to="/login"
          className="mt-6 text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400"
        >
          {verifyT.backToLogin}
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center py-12 text-center">
      <Loader2 className="h-10 w-10 animate-spin text-teal-600 dark:text-teal-400" aria-hidden />
      <h1 className="mt-6 text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        {verifyT.confirming ?? 'Confirming your email…'}
      </h1>
      <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
        {verifyT.confirmingHint ?? 'You will be redirected in a moment.'}
      </p>
    </div>
  )
}
