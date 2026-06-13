import { useCallback, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'

interface CopierPauseToggleProps {
  className?: string
}

export function CopierPauseToggle({ className }: CopierPauseToggleProps) {
  const t = useT()
  const cp = t.nav.copierPause
  const { copierPaused, patchProfile, persistProfile, refreshProfile } = useUserProfile()
  const [saving, setSaving] = useState(false)

  const toggle = useCallback(async () => {
    if (saving) return
    const next = !copierPaused
    setSaving(true)
    patchProfile({ copier_paused: next })
    try {
      await persistProfile({ copier_paused: next })
    } catch {
      await refreshProfile()
    } finally {
      setSaving(false)
    }
  }, [copierPaused, patchProfile, persistProfile, refreshProfile, saving])

  const label = copierPaused ? cp.resumeLabel : cp.pauseLabel

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={saving}
      aria-pressed={copierPaused}
      aria-label={label}
      title={copierPaused ? cp.pausedHint : label}
      className={clsx(
        'p-2 rounded-lg transition-colors disabled:opacity-50',
        copierPaused
          ? 'text-amber-600 bg-amber-50 hover:bg-amber-100 dark:text-amber-400 dark:bg-amber-950/40 dark:hover:bg-amber-950/60'
          : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800',
        className,
      )}
    >
      {copierPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
    </button>
  )
}
