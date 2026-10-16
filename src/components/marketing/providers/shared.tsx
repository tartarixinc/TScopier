import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMarketingAuthState } from '../../../hooks/useMarketingAuthState'
import { NOISE_BG } from './helpers'
import { appUrl, withQuery } from '../../../lib/site'
import { trackMarketingEvent } from '../../../lib/analytics'

export function Grain({ className }: { className?: string }) {
  return (
    <div
      className={clsx('pointer-events-none absolute inset-0 mix-blend-screen', className)}
      style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
      aria-hidden
    />
  )
}

export function Eyebrow({ children, onDark = false }: { children: ReactNode; onDark?: boolean }) {
  return (
    <p
      className={clsx(
        'inline-flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.18em]',
        onDark ? 'text-green-400' : 'text-neutral-900 dark:text-neutral-50',
      )}
    >
      <span className="h-2 w-2 bg-green-400" aria-hidden />
      {children}
    </p>
  )
}

const ctaBase =
  'group inline-flex items-center justify-center gap-2 rounded-full border border-green-400 bg-green-400 px-6 py-3 text-sm font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_10px_28px_-10px_rgba(74,222,128,0.7)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_24px_rgba(74,222,128,0.5)] sm:px-7 sm:py-3.5 sm:text-base'

/** Primary provider call to action: sign up, or jump to the Social Trading page when signed in. */
export function ProviderCta({
  label,
  placement,
  className,
}: {
  label: string
  placement: string
  className?: string
}) {
  const { isSignedIn, loading } = useMarketingAuthState()
  const ref =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('ref')?.trim() || null
  const href = isSignedIn
    ? appUrl('/social-trading')
    : withQuery(appUrl('/signup'), { ref })

  return (
    <a
      href={href}
      aria-busy={loading || undefined}
      onClick={() =>
        trackMarketingEvent('marketing_cta_click', {
          action: isSignedIn ? 'dashboard' : 'signup',
          variant: `providers_${placement}`,
        })
      }
      className={clsx(ctaBase, className)}
    >
      {label}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" aria-hidden />
    </a>
  )
}
