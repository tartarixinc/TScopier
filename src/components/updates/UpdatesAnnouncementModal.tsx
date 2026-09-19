import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Sparkles, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { PLATFORM_UPDATES, SEEN_UPDATES_KEY, type PlatformUpdate } from '../../lib/platformUpdates'
import { useT } from '../../context/LocaleContext'

const TYPE_STYLES: Record<string, string> = {
  feature: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
  fix: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  improvement: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400',
}

function getSeenUpdates(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_UPDATES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function markUpdatesSeen(ids: string[]) {
  const seen = getSeenUpdates()
  for (const id of ids) seen.add(id)
  localStorage.setItem(SEEN_UPDATES_KEY, JSON.stringify([...seen]))
}

function findLatestUnseenUpdate() {
  const seen = getSeenUpdates()
  return PLATFORM_UPDATES.find(u => !seen.has(u.id)) ?? null
}

function typeLabel(type: PlatformUpdate['type'], t: ReturnType<typeof useT>): string {
  const map: Record<PlatformUpdate['type'], string> = {
    feature: t.nav.updatesPage.typeFeature,
    fix: t.nav.updatesPage.typeFix,
    improvement: t.nav.updatesPage.typeImprovement,
  }
  return map[type]
}

/** Announcement modal shown once per update when the user opens the app. */
export function UpdatesAnnouncementModal() {
  const navigate = useNavigate()
  const t = useT()
  const [open, setOpen] = useState(() => findLatestUnseenUpdate() !== null)
  const [current, setCurrent] = useState(() => findLatestUnseenUpdate())
  const backdropRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const pointerDownTarget = useRef<EventTarget | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const dismiss = useCallback(() => {
    if (current) markUpdatesSeen([current.id])
    setOpen(false)
    setCurrent(null)
  }, [current])

  const viewAll = useCallback(() => {
    if (current) markUpdatesSeen([current.id])
    setOpen(false)
    setCurrent(null)
    navigate('/updates')
  }, [current, navigate])

  // Focus trap + Escape to close + body scroll lock
  useEffect(() => {
    if (!open) return
    // Focus the close button on open
    closeButtonRef.current?.focus()

    const dialog = overlayRef.current?.querySelector('[role="dialog"]') as HTMLElement | null
    if (!dialog) return

    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = dialog.querySelectorAll<HTMLElement>(focusableSelector)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
    }
  }, [open, dismiss])

  const onOverlayMouseDown = useCallback((e: React.MouseEvent) => {
    pointerDownTarget.current = e.target
  }, [])

  const onOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      const isBackdrop =
        (e.target === overlayRef.current || e.target === backdropRef.current) &&
        (pointerDownTarget.current === overlayRef.current || pointerDownTarget.current === backdropRef.current)
      if (isBackdrop) dismiss()
      pointerDownTarget.current = null
    },
    [dismiss],
  )

  if (!open || !current) return null

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/40" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="updates-modal-title"
        className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 animate-modal-in overflow-hidden"
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={dismiss}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 py-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 dark:bg-teal-950/40">
            <Sparkles className="h-7 w-7 text-teal-600 dark:text-teal-400" />
          </div>

          <h2
            id="updates-modal-title"
            className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50"
          >
            {t.nav.updatesAnnouncement.title}
          </h2>

          <div className="mt-4 text-left">
            <div className="flex items-center gap-2 mb-2">
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TYPE_STYLES[current.type]}`}>
                {typeLabel(current.type, t)}
              </span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">{current.date}</span>
            </div>
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {current.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {current.description}
            </p>
          </div>

          <div className="mt-6 flex flex-col gap-2">
            <Button variant="primary" onClick={viewAll}>
              {t.nav.updatesAnnouncement.viewAll}
            </Button>
            <button
              type="button"
              onClick={dismiss}
              className="text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              {t.nav.updatesAnnouncement.dismiss}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
