import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { PricingPlansPanel } from './PricingPlansPanel'

interface PricingModalProps {
  open: boolean
  onClose: () => void
}

export function PricingModal({ open, onClose }: PricingModalProps) {
  const t = useT()
  const pt = t.pricing
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      <div className="fixed inset-0 bg-neutral-950/50 backdrop-blur-sm" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-modal-title"
        className="relative my-4 w-full max-w-5xl rounded-3xl bg-neutral-50 shadow-2xl dark:bg-neutral-950 sm:my-8"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-3xl border-b border-neutral-200 bg-neutral-50/95 px-6 py-5 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 sm:px-8">
          <div>
            <h2
              id="pricing-modal-title"
              className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl"
            >
              {pt.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.cancel}
            className="shrink-0 rounded-xl p-2.5 text-neutral-400 transition-colors hover:bg-neutral-200/80 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-6 sm:px-8 sm:py-8">
          <PricingPlansPanel onDismiss={onClose} />
        </div>
      </div>
    </div>
  )
}
