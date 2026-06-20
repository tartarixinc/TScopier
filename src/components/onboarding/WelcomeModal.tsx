import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2 } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { saveUserProfile } from '../../lib/userProfile'
import { startPlanCheckout } from '../../lib/planCheckout'
import { useLocale, useT } from '../../context/LocaleContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { Button } from '../ui/Button'

/** Blocks the app until the user starts a trial or explores the dashboard. */
export function WelcomeModal() {
  const t = useT()
  const { auth } = useLocale()
  const welcomeT = auth.welcome
  const { user, session } = useAuth()
  const { profile, refreshProfile } = useUserProfile()
  const { openPricingModal, isPastDue, effectivePlan, hasTrialExpired, hasActiveSubscription } = useSubscription()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const trialCta = getSubscribeCtaLabel(t, { isPastDue, effectivePlan, hasTrialExpired })

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const completeOnboarding = async () => {
    if (!user) return
    await saveUserProfile(user.id, {
      ...profile,
      onboarding_completed_at: new Date().toISOString(),
    })
    await refreshProfile()
  }

  const startFreeTrial = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      await completeOnboarding()
      if (hasActiveSubscription) return
      const token = session?.access_token
      if (!token) throw new Error(welcomeT.checkoutFailed)
      const url = await startPlanCheckout({
        accessToken: token,
        plan: 'advanced',
        interval: 'monthly',
        cancelUrl: `${window.location.origin}/pricing`,
      })
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : welcomeT.checkoutFailed)
      setSaving(false)
    }
  }

  const seePricing = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      await completeOnboarding()
      openPricingModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : welcomeT.errorFallback)
    } finally {
      setSaving(false)
    }
  }

  const exploreDashboard = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      await completeOnboarding()
    } catch (e) {
      setError(e instanceof Error ? e.message : welcomeT.errorFallback)
    } finally {
      setSaving(false)
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      aria-hidden={false}
    >
      <div className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 animate-modal-in overflow-hidden"
      >
        <div className="px-6 py-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-950/40">
            <CheckCircle2 className="h-8 w-8 text-teal-600 dark:text-teal-400" />
          </div>

          <h2
            id="welcome-modal-title"
            className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50"
          >
            {welcomeT.title}
          </h2>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{welcomeT.subtitle}</p>

          <ul className="mt-6 space-y-2.5 text-left text-sm text-neutral-600 dark:text-neutral-400">
            {welcomeT.steps.map(step => (
              <li key={step} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>{step}</span>
              </li>
            ))}
          </ul>

          {error ? (
            <p className="mt-5 text-sm text-amber-700 dark:text-amber-300">{error}</p>
          ) : null}

          <Button
            className="mt-8 w-full"
            size="lg"
            loading={saving}
            onClick={() => void startFreeTrial()}
          >
            {trialCta}
          </Button>

          <Button
            className="mt-3 w-full"
            size="lg"
            variant="secondary"
            disabled={saving}
            onClick={() => void seePricing()}
          >
            {welcomeT.seePricing}
          </Button>

          <button
            type="button"
            onClick={() => void exploreDashboard()}
            disabled={saving}
            className="mt-4 text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 disabled:opacity-50"
          >
            {welcomeT.exploreDashboard}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
