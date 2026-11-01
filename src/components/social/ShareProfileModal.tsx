import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ProviderShareCard } from './ProviderShareCard'

/** Share your public provider link: copy it, post it, or scan the QR code. */
export function ShareProfileModal({ slug, name, shareTradeHistory, manageHref, onClose }: {
  slug: string
  name: string
  shareTradeHistory?: boolean | null
  manageHref?: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="share-profile-title">
      <button type="button" className="absolute inset-0 bg-neutral-950/60" aria-label="Close share dialog" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 sm:max-w-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 id="share-profile-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Share profile</h2>
          <button ref={closeRef} type="button" className="rounded-lg p-2 hover:bg-neutral-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 dark:hover:bg-neutral-800" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">
          <ProviderShareCard slug={slug} name={name} shareTradeHistory={shareTradeHistory} manageHref={manageHref} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
