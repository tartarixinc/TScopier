import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, AlertTriangle, RefreshCw, X } from 'lucide-react'
import type { BrokerAccount } from '../../types/database'
import type { ReconnectDialogStage } from '../../lib/migrationPrompt'
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
  passwordHint?: string
  passwordPlaceholder: string
  /** "Remind me later" postpones this account until the next app load. */
  remindLater?: string
  /** Muted escape hatch for an account that can never be reconnected. */
  deleteAccountLink?: string
  deleteConfirmTitle?: string
  deleteConfirmBody?: string
  deleteConfirmNote?: string
  deleteConfirmCta?: string
  detailLogin: string
  detailServer: string
  reconnect: string
  cancel: string
  back?: string
  /** Shown under the body when several accounts are queued — tells the customer they will be asked for each one. */
  hint?: string
  /** Stage `success`: the action button — "Next account" or "Done". */
  successAction?: string
}

interface BrokerReconnectPasswordModalProps {
  open: boolean
  broker: BrokerAccount | null
  /**
   * The caller owns the stage because it also owns which prompt (migration,
   * session-expiry, in-flight attempt, success confirmation) is showing.
   * See `ReconnectDialogStage` in `src/lib/migrationPrompt.ts`.
   */
  stage: ReconnectDialogStage
  copy: BrokerReconnectPasswordModalCopy
  onSubmit: (payload: { password: string; rememberPassword: boolean }) => void
  onCancel: () => void
  /** Stage 1 → stage 2. Starts the reconnect that ends in the password prompt. */
  onContinue?: () => void
  /** Stage 2 → stage 1 (only when the caller offers it). */
  onBack?: () => void
  /** Postpone this account until the next app load. */
  onRemindLater?: () => void
  /** Permanent exit for an account that cannot be reconnected. */
  onDeleteAccount?: () => void
  /** Last reconnect failure, shown in the dialog when the page has no toast. */
  error?: string | null
  /**
   * When false the dialog cannot be dismissed at all: no close button, no
   * Escape, no backdrop click, no Cancel — it stays until the account is
   * resolved. The automatic migration prompt passes false; a dialog the
   * customer opened themselves stays closable. Dismissal is always refused
   * on the `connecting` stage regardless of this prop.
   */
  dismissible?: boolean
}

function BrokerReconnectPasswordModalInner({
  open,
  broker,
  stage,
  copy,
  onSubmit,
  onCancel,
  onContinue,
  onBack,
  onRemindLater,
  onDeleteAccount,
  error,
  dismissible = true,
}: BrokerReconnectPasswordModalProps) {
  const [password, setPassword] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const scrollLockRef = useRef<string | null>(null)
  const ignoreDismiss = useCallback(() => {}, [])
  // The effects below need the latest cancel handler without re-running when
  // the caller recreates it (health polling would steal focus on every poll).
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  })
  const stableCancel = useCallback(() => {
    onCancelRef.current()
  }, [])
  // The dialog itself refuses dismissal while the bridge is working: an X or
  // Escape that does nothing is worse than no X at all. This holds even if a
  // caller passes stage='connecting' with dismissible=true.
  const canDismiss = dismissible && stage !== 'connecting'
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(
    overlayRef,
    backdropRef,
    canDismiss ? stableCancel : ignoreDismiss,
  )

  useEffect(() => {
    if (!open) {
      setPassword('')
      return
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canDismiss) onCancelRef.current()
    }
    document.addEventListener('keydown', handleKey)
    const focusTimer = window.setTimeout(() => {
      const target = stage === 'password'
        ? document.getElementById('broker-reconnect-password')
        : document.getElementById('broker-reconnect-dialog')
      target?.focus()
    }, 50)
    return () => {
      document.removeEventListener('keydown', handleKey)
      window.clearTimeout(focusTimer)
    }
  }, [open, stage, canDismiss])

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

  // Steps out of the way for an account that cannot be reconnected right now:
  // postpone until the next app load, or remove the account for good.
  const secondaryActions = (onRemindLater || onDeleteAccount) ? (
    <div className="space-y-2 pt-1">
      {onRemindLater && copy.remindLater ? (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={onRemindLater}
        >
          {copy.remindLater}
        </Button>
      ) : null}
      {onDeleteAccount && copy.deleteAccountLink ? (
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="w-full text-center text-xs text-neutral-400 underline underline-offset-2 transition-colors hover:text-error-600 disabled:opacity-50 dark:text-neutral-500 dark:hover:text-error-400"
        >
          {copy.deleteAccountLink}
        </button>
      ) : null}
    </div>
  ) : null

  if (confirmingDelete) {
    return createPortal(
      <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <div
          className="absolute inset-0 bg-neutral-950/55"
          aria-hidden
          onClick={() => setConfirmingDelete(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
        >
          <div className="px-5 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                  {copy.deleteConfirmTitle}
                </h2>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  {copy.deleteConfirmBody}
                </p>
                <p className="mt-2 text-xs font-medium text-error-600 dark:text-error-400">
                  {copy.deleteConfirmNote}
                </p>
              </div>
            </div>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div className="rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-800/50">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{broker.label}</p>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {copy.detailLogin}: {broker.account_login || '—'}
              </p>
            </div>
            <div className="flex gap-3">
              <Button className="flex-1" variant="secondary" onClick={() => setConfirmingDelete(false)}>
                {copy.cancel}
              </Button>
              <Button
                className="flex-1"
                variant="danger"
                onClick={() => {
                  setConfirmingDelete(false)
                  onDeleteAccount?.()
                }}
              >
                {copy.deleteConfirmCta}
              </Button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  const logo = platformLogo(broker.platform)
  const headerIcon =
    stage === 'connecting' ? (
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    ) : stage === 'success' ? (
      <CheckCircle2 className="h-5 w-5" aria-hidden />
    ) : (
      <AlertTriangle className="h-5 w-5" aria-hidden />
    )
  const headerTint =
    stage === 'success'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400'
      : 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400'

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
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        id="broker-reconnect-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="broker-reconnect-password-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${headerTint}`}
            >
              {headerIcon}
            </div>
            <div
              className="min-w-0 flex-1"
              {...(stage === 'connecting' || stage === 'success'
                ? { role: 'status' as const }
                : {})}
            >
              <h2
                id="broker-reconnect-password-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {copy.title}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {copy.body}
              </p>
              {copy.hint && (
                <p className="mt-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 leading-relaxed">
                  {copy.hint}
                </p>
              )}
            </div>
            {canDismiss && (
              <button
                type="button"
                onClick={onCancel}
                aria-label={copy.cancel}
                className="shrink-0 rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            )}
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

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-error-200 bg-error-50 px-3 py-2 text-sm text-error-700 dark:border-error-900/60 dark:bg-error-950/40 dark:text-error-300"
            >
              {error}
            </div>
          )}

          {stage === 'details' && (
            <div className="flex justify-end gap-2 pt-1">
              {canDismiss && (
                <Button type="button" variant="ghost" onClick={onCancel}>
                  {copy.cancel}
                </Button>
              )}
              <Button type="button" onClick={onContinue}>
                <RefreshCw className="h-4 w-4" />
                {copy.reconnect}
              </Button>
            </div>
          )}

          {secondaryActions}

          {stage === 'password' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <PasswordInput
                id="broker-reconnect-password"
                label={copy.passwordLabel}
                placeholder={copy.passwordPlaceholder}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />

              <div className="flex items-center justify-between gap-2 pt-1">
                <div>
                  {onBack && (
                    <Button type="button" variant="ghost" onClick={onBack}>
                      {copy.back ?? copy.cancel}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {canDismiss && (
                    <Button type="button" variant="ghost" onClick={onCancel}>
                      {copy.cancel}
                    </Button>
                  )}
                  <Button type="submit" disabled={!password.trim()}>
                    <RefreshCw className="h-4 w-4" />
                    {copy.reconnect}
                  </Button>
                </div>
              </div>
            </form>
          )}

          {secondaryActions}

          {/* `connecting` has no footer: the header spinner and body text
              carry the waiting state — a second copy of the same sentence
              below would just print it twice. */}
          {stage === 'success' && (
            <div className="flex justify-end pt-1">
              <Button type="button" onClick={onContinue}>
                {copy.successAction ?? copy.reconnect}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

export const BrokerReconnectPasswordModal = memo(BrokerReconnectPasswordModalInner)
