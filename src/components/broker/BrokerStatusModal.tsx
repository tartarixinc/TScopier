import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  CheckCircle2,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react'
import clsx from 'clsx'
import type { BrokerAccount } from '../../types/database'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { BrokerHealthCheckUnsupportedError, fxsocketBroker } from '../../lib/fxsocketBroker'
import {
  isFxsocketMtStatusHealthy,
  listFxsocketMtStatusChecks,
  type FxsocketMtStatus,
  type FxsocketMtStatusCheckId,
} from '../../lib/fxsocketMtStatus'

import type { BrokerStatusModalCopy } from '../../i18n/locales/types'

interface BrokerStatusModalProps {
  open: boolean
  broker: BrokerAccount | null
  copy: BrokerStatusModalCopy
  onClose: () => void
  onAccountUpdate?: (account: BrokerAccount) => void
}

function platformLogo(platform: string): string | null {
  if (platform === 'MT5') return '/MT5.png'
  if (platform === 'MT4') return '/MT4.png'
  return null
}

function formatServerTime(iso?: string): string {
  if (!iso) return '—'
  const d = Date.parse(iso)
  if (!Number.isFinite(d)) return iso
  return new Date(d).toLocaleString()
}

function checkLabel(id: FxsocketMtStatusCheckId, copy: BrokerStatusModalCopy): string {
  const labels: Record<FxsocketMtStatusCheckId, string> = {
    statusReady: copy.checkStatusReady,
    terminalAlive: copy.checkTerminalAlive,
    brokerConnected: copy.checkBrokerConnected,
    accountLoggedIn: copy.checkAccountLoggedIn,
    accountTradeAllowed: copy.checkAccountTradeAllowed,
    bridgeTradeEaReady: copy.checkBridgeTradeEaReady,
    bridgeSymbolsSynced: copy.checkBridgeSymbolsSynced,
  }
  return labels[id]
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean
  detail?: string
}) {
  const Icon = ok ? CheckCircle2 : XCircle
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon
        className={clsx(
          'mt-0.5 h-4 w-4 shrink-0',
          ok ? 'text-primary-600 dark:text-primary-400' : 'text-error-600 dark:text-error-400',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-800 dark:text-neutral-100">{label}</p>
        {detail ? (
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Activity
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/40 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-neutral-500 dark:text-neutral-400" aria-hidden />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {title}
        </h3>
      </div>
      <div className="divide-y divide-neutral-200/80 dark:divide-neutral-700/80">
        {children}
      </div>
    </section>
  )
}

function BrokerStatusModalInner({
  open,
  broker,
  copy,
  onClose,
  onAccountUpdate,
}: BrokerStatusModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const scrollLockRef = useRef<string | null>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onClose)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [status, setStatus] = useState<FxsocketMtStatus | null>(null)

  const loadStatus = useCallback(async () => {
    if (!broker) return
    setLoading(true)
    setError(null)
    setUnsupported(false)
    try {
      const result = await fxsocketBroker.fetchBrokerStatus(broker.id)
      setStatus(result.status)
      onAccountUpdate?.(result.account)
    } catch (e) {
      setStatus(null)
      if (e instanceof BrokerHealthCheckUnsupportedError) {
        setUnsupported(true)
      } else {
        setError(e instanceof Error ? e.message : copy.loadFailed)
      }
    } finally {
      setLoading(false)
    }
  }, [broker, copy.loadFailed, onAccountUpdate])

  useEffect(() => {
    if (!open || !broker) {
      setStatus(null)
      setError(null)
      setUnsupported(false)
      setLoading(false)
      return
    }
    void loadStatus()
  }, [open, broker, loadStatus])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

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
  const healthy = status ? isFxsocketMtStatusHealthy(status) : false
  const checks = status ? listFxsocketMtStatusChecks(status) : []

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="broker-status-modal-title"
        className="relative flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 animate-modal-in"
      >
        <div className="shrink-0 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="flex items-start gap-3">
            {logo ? (
              <img src={logo} alt="" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-teal-950/60">
                <Activity className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2
                id="broker-status-modal-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {copy.title}
              </h2>
              <p className="mt-0.5 truncate text-sm text-neutral-500 dark:text-neutral-400">
                {broker.label}
              </p>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{copy.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              aria-label={copy.close}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {status && !loading ? (
            <div
              className={clsx(
                'mt-4 rounded-xl border px-3 py-3',
                healthy
                  ? 'border-primary-200 bg-primary-50/80 dark:border-primary-900/50 dark:bg-primary-950/30'
                  : 'border-error-200 bg-error-50/80 dark:border-error-900/50 dark:bg-error-950/30',
              )}
            >
              <div className="flex items-center gap-2">
                <Badge variant={healthy ? 'primary' : 'error'} size="sm">
                  {healthy ? copy.healthyTitle : copy.unhealthyTitle}
                </Badge>
                <span className="text-xs text-neutral-600 dark:text-neutral-300">
                  {healthy ? copy.healthyBody : copy.unhealthyBody}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-neutral-500 dark:text-neutral-400">
              <RefreshCw className="h-5 w-5 animate-spin" aria-hidden />
              {copy.loading}
            </div>
          ) : unsupported ? (
            <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{copy.unsupported}</p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-error-600 dark:text-error-400">{error}</p>
          ) : status ? (
            <div className="space-y-3">
              <SectionCard title={copy.sectionOverall} icon={ShieldCheck}>
                {checks.map(check => (
                  <StatusRow
                    key={check.id}
                    label={checkLabel(check.id, copy)}
                    ok={check.ok}
                    detail={
                      check.id === 'statusReady' && typeof check.value === 'string'
                        ? check.value
                        : undefined
                    }
                  />
                ))}
              </SectionCard>

              <SectionCard title={copy.sectionTerminal} icon={Activity}>
                <StatusRow
                  label={copy.checkTerminalAlive}
                  ok={status.terminal?.alive === true}
                  detail={[
                    status.terminal?.build != null ? `${copy.labelBuild} ${status.terminal.build}` : null,
                    status.terminal?.pingMs != null ? `${copy.labelPing} ${status.terminal.pingMs} ms` : null,
                  ].filter(Boolean).join(' · ') || undefined}
                />
              </SectionCard>

              <SectionCard title={copy.sectionBroker} icon={Server}>
                <StatusRow
                  label={copy.checkBrokerConnected}
                  ok={status.broker?.connected === true}
                  detail={status.broker?.server ? `${copy.labelServer}: ${status.broker.server}` : undefined}
                />
              </SectionCard>

              <SectionCard title={copy.sectionAccount} icon={ShieldCheck}>
                <StatusRow
                  label={copy.checkAccountLoggedIn}
                  ok={status.account?.loggedIn === true}
                />
                <StatusRow
                  label={copy.checkAccountTradeAllowed}
                  ok={status.account?.tradeAllowed === true}
                />
                <div className="grid grid-cols-2 gap-x-4 py-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <div>
                    <span className="text-neutral-500 dark:text-neutral-400">{copy.labelLogin}</span>
                    <p className="mt-0.5 font-medium text-neutral-800 dark:text-neutral-100">
                      {status.account?.login ?? broker.account_login ?? '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-neutral-500 dark:text-neutral-400">{copy.labelCurrency}</span>
                    <p className="mt-0.5 font-medium text-neutral-800 dark:text-neutral-100">
                      {status.account?.currency ?? '—'}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-neutral-500 dark:text-neutral-400">{copy.labelAccountType}</span>
                    <p className="mt-0.5 font-medium text-neutral-800 dark:text-neutral-100">
                      {status.account?.type ?? '—'}
                    </p>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={copy.sectionBridge} icon={Activity}>
                <StatusRow
                  label={copy.checkBridgeTradeEaReady}
                  ok={status.bridge?.tradeEaReady === true}
                />
                <StatusRow
                  label={copy.checkBridgeSymbolsSynced}
                  ok={status.bridge?.symbolsSynced === true}
                />
                <div className="py-2 text-xs">
                  <span className="text-neutral-500 dark:text-neutral-400">{copy.labelBridgeVersion}</span>
                  <p className="mt-0.5 font-medium text-neutral-800 dark:text-neutral-100">
                    {status.bridge?.version ?? '—'}
                  </p>
                </div>
              </SectionCard>

              <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">
                {copy.serverTime}: {formatServerTime(status.serverTime)}
              </p>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <Button type="button" variant="secondary" onClick={onClose}>
            {copy.close}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={loading}
            onClick={() => void loadStatus()}
            disabled={unsupported}
          >
            <RefreshCw className="h-4 w-4" />
            {copy.refresh}
          </Button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

export const BrokerStatusModal = memo(BrokerStatusModalInner)
