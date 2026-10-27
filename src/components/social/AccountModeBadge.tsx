import clsx from 'clsx'
import type { SocialAccountMode } from '../../lib/socialAccount'

export function AccountModeBadge({ mode }: { mode: SocialAccountMode }) {
  return (
    <span className={clsx(
      'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
      mode === 'demo'
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : mode === 'live'
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
    )}>
      {mode === 'demo' ? 'Demo' : mode === 'live' ? 'Live' : 'Unknown'}
    </span>
  )
}
