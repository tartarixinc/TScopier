import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import type { BrokerAccount } from '../../types/database'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { PasswordInput } from '../auth/PasswordInput'
import { Button } from '../ui/Button'

function platformLogo(platform: string): string | null {
  if (platform === 'MT5') return '/MT5.png'
  if (platform === 'MT4') return '/MT4.png'
  return null
}

export interface BrokerReconnectPasswordModalCopy {
  title: string
  body: string
  passwordLabel: string
  passwordHint: string
  passwordPlaceholder: string
  rememberPasswordLabel: string
  rememberPasswordHint: string
  detailLogin: string
  detailServer: string
  reconnect: string
  cancel: string
}

interface BrokerReconnectPasswordModalProps {
  open: boolean
  broker: BrokerAccount | null
  copy: BrokerReconnectPasswordModalCopy
  onSubmit: (payload: { password: string; rememberPassword: boolean }) => void
  onCancel: () => void
}

function BrokerReconnectPasswordModalInner({
  open,
  broker,
  copy,
  onSubmit,
  onCancel,
}: BrokerReconnectPasswordModalProps) {
  const [password, setPassword] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const scrollLockRef = useRef<string | null>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onCancel)

  useEffect(() => {
    if (!open) {
      setPassword('')
      return
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    const focusTimer = window.setTimeout(() => {
      document.getElementById('broker-reconnect-password')?.focus()
    }, 50)
    return () => {
      document.removeEventListener('keydown', handleKey)
      window.clearTimeout(focusTimer)
    }
  }, [open, onCancel])

  useEffect(() => {
    if (!open) {
      if (scrollLockRef.current != null) {
        document.body.style.overflow = scrollLockRef.current
        scrollLockRef.current = null
      }
      return
    }
    scrollLockRef.current = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = scrollLockRef.current ?? ''
      scrollLockRef.current = null
    }
  }, [open])

  if (!open || !broker) return null

  const logo = platformLogo(broker.platform)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = password.trim()
    if (!trimmed) return
    onSubmit({ password: trimmed, rememberPassword: true })
  }

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/50" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="broker-reconnect-password-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="broker-reconnect-password-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {copy.title}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {copy.body}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label={copy.cancel}
              className="shrink-0 rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-800/50">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-neutral-900">
              {logo ? (
                <img src={logo} alt={broker.platform} className="h-8 w-8 object-contain" decoding="async" />
              ) : (
                <span className="text-xs font-semibold text-neutral-500">{broker.platform}</span>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                {broker.label}
              </p>
              <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                {copy.detailLogin}: {broker.account_login || '—'}
              </p>
              {broker.broker_server && (
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {copy.detailServer}: {broker.broker_server}
                </p>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <PasswordInput
              id="broker-reconnect-password"
              label={copy.passwordLabel}
              placeholder={copy.passwordPlaceholder}
              value={password}
              onChange={e => setPassword(e.target.value)}
              hint={copy.passwordHint}
              autoComplete="current-password"
              required
            />

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onCancel}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={!password.trim()}>
                <RefreshCw className="h-4 w-4" />
                {copy.reconnect}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

export const BrokerReconnectPasswordModal = memo(BrokerReconnectPasswordModalInner)
