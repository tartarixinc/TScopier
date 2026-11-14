import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { CandlestickChart, Radio, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { saveUserProfile } from '../../lib/userProfile'
import { useLocale } from '../../context/LocaleContext'
import { Button } from '../ui/Button'
import { TscopierLogo } from '../ui/TscopierLogo'

const FEATURE_ICONS = [Radio, CandlestickChart, ShieldCheck] as const

/** Onboarding overlay; dashboard renders behind for a live preview. */
export function WelcomeModal() {
  const navigate = useNavigate()
  const { auth } = useLocale()
  const welcomeT = auth.welcome
  const { user } = useAuth()
  const { profile, refreshProfile } = useUserProfile()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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

  const startUsing = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      await completeOnboarding()
      navigate('/channels', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : welcomeT.errorFallback)
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
      setSaving(false)
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-100 flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      aria-hidden={false}
    >
      <div className="absolute inset-0 bg-neutral-950/50 backdrop-blur-[2px]" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-neutral-200/70 bg-white shadow-2xl animate-modal-in dark:border-neutral-800/60 dark:bg-neutral-900"
      >
        <div
          className="relative overflow-hidden px-6 pb-5 pt-7 sm:px-8 sm:pt-8"
          style={{
            background:
              'radial-gradient(120% 90% at 10% -10%, rgba(52, 211, 153, 0.22), transparent 55%), radial-gradient(90% 70% at 100% 0%, rgba(16, 185, 129, 0.12), transparent 50%)',
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-neutral-200/80 to-transparent dark:via-neutral-700/70" />
          <div className="flex flex-col items-center text-center">
            <div className="mb-5 rounded-2xl border border-white/50 bg-white/70 px-4 py-2.5 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-neutral-950/50">
              <TscopierLogo brand="unicopier" className="h-7 w-auto" />
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
              {welcomeT.eyebrow}
            </p>
            <h2
              id="welcome-modal-title"
              className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-[1.7rem]"
            >
              {welcomeT.title}
            </h2>
            <p className="mt-2.5 max-w-md text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              {welcomeT.subtitle}
            </p>
          </div>
        </div>

        <div className="px-6 pb-7 pt-5 sm:px-8 sm:pb-8">
          <ul className="space-y-2.5">
            {welcomeT.features.map((feature, index) => {
              const Icon = FEATURE_ICONS[index] ?? Radio
              return (
                <li key={feature.title}>
                  <FeatureRow
                    icon={<Icon className="h-4 w-4" aria-hidden />}
                    title={feature.title}
                    description={feature.description}
                  />
                </li>
              )
            })}
          </ul>

          {error ? (
            <p className="mt-5 text-sm text-amber-700 dark:text-amber-300">{error}</p>
          ) : null}

          <Button
            className="mt-7 w-full"
            size="lg"
            variant="primary"
            loading={saving}
            onClick={() => void startUsing()}
          >
            {welcomeT.startUsing}
          </Button>

          <button
            type="button"
            onClick={() => void exploreDashboard()}
            disabled={saving}
            className="mt-3.5 w-full text-center text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-300 dark:hover:text-neutral-50"
          >
            {welcomeT.exploreDashboard}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

function FeatureRow({
  icon,
  title,
  description,
}: {
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3.5 rounded-2xl border border-neutral-200/70 bg-neutral-50/80 px-3.5 py-3.5 dark:border-neutral-800/70 dark:bg-white/3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:bg-emerald-400/12 dark:text-emerald-300">
        {icon}
      </div>
      <div className="min-w-0 text-left">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</p>
        <p className="mt-0.5 text-sm leading-snug text-neutral-600 dark:text-neutral-400">{description}</p>
      </div>
    </div>
  )
}
