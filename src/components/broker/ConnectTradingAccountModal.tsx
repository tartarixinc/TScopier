import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { fxsocketBroker } from '../../lib/fxsocketBroker'
import {
  emptyConnectTradingAccountForm,
  type ConnectTradingAccountForm,
} from '../../lib/connectTradingAccountForm'
import {
  inferServerPlatform,
  type TradingPlatform,
} from '../../lib/tradingPlatform'
import {
  connectAccountsBatch,
  emptyConnectRows,
  resolveActiveBrokerCount,
  validateConnectRow,
  type BulkConnectResult,
  type BulkConnectRowProgress,
} from '../../lib/bulkConnectBrokers'
import {
  brokerConnectErrorLabelsFromI18n,
  userFacingBrokerConnectError,
} from '../../lib/brokerConnectError'
import { PasswordInput } from '../auth/PasswordInput'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import type { BrokerAccount } from '../../types/database'
import { PaywallErrorAlert } from '../billing/PaywallErrorAlert'
import { BulkUploadAccountsModal } from './BulkUploadAccountsModal'
import { ConnectAccountsBatchProgress } from './ConnectAccountsBatchProgress'
import { MtCompanyServerPicker } from '../ui/MtCompanyServerPicker'

type ConnectTradingAccountModalProps = {
  open: boolean
  onClose: () => void
  onSuccess?: (broker: BrokerAccount) => void
  onBatchSuccess?: (result: BulkConnectResult) => void
}

type ConnectStep = 0 | 1 | 2

function countValidRows(rows: ConnectTradingAccountForm[]): number {
  return rows.filter(row => validateConnectRow(row) == null).length
}

export function ConnectTradingAccountModal({
  open,
  onClose,
  onSuccess,
  onBatchSuccess,
}: ConnectTradingAccountModalProps) {
  const t = useT()
  const cf = t.accountConfig.connectForm
  const bc = t.accountConfig.bulkConnect
  const bl = t.accountConfig.brokerList
  const pw = t.pricing.paywall
  const connectErrorLabels = brokerConnectErrorLabelsFromI18n(bl)
  const { brokers, upsertBroker } = useBrokerAccounts()
  const { hasActiveSubscription, limits, usage, isAdmin } = useSubscription()
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const connectStartedAtRef = useRef(0)
  const brokersRef = useRef(brokers)
  brokersRef.current = brokers

  const [rows, setRows] = useState<ConnectTradingAccountForm[]>(() => emptyConnectRows())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [connectStep, setConnectStep] = useState<ConnectStep>(0)
  const [batchRows, setBatchRows] = useState<BulkConnectRowProgress[]>([])
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false)

  const reset = useCallback(() => {
    setRows(emptyConnectRows())
    setError('')
    setSaving(false)
    setConnectStep(0)
    setBatchRows([])
    setBulkUploadOpen(false)
  }, [])

  const handleClose = useCallback(() => {
    if (saving) return
    reset()
    onClose()
  }, [onClose, reset, saving])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, handleClose)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) handleClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, handleClose, saving])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  useEffect(() => {
    if (!saving) return
    connectStartedAtRef.current = Date.now()
    setConnectStep(0)
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - connectStartedAtRef.current
      if (elapsed >= 45_000) setConnectStep(2)
      else if (elapsed >= 12_000) setConnectStep(1)
      else setConnectStep(0)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [saving])

  const setRowField = useCallback((
    index: number,
    field: keyof ConnectTradingAccountForm,
    value: string,
  ) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }, [])

  const addRow = useCallback(() => {
    setRows(prev => [...prev, {
      ...emptyConnectTradingAccountForm,
      platform: prev[0]?.platform ?? 'MT5',
    }])
  }, [])

  const removeRow = useCallback((index: number) => {
    setRows(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }, [])

  const activeBrokerCount = resolveActiveBrokerCount(brokers, usage.brokerAccounts)

  const setPlatform = useCallback((platform: TradingPlatform) => {
    setRows(prev => prev.map(row => ({ ...row, platform })))
  }, [])

  const connectSingle = async (row: ConnectTradingAccountForm) => {
    const login = row.account_number.trim()
    const server = row.broker_server.trim()
    const platform = row.platform
    const { account } = await fxsocketBroker.connect({
      login,
      password: row.account_password,
      server,
      platform,
      label: row.label.trim() || undefined,
    })
    upsertBroker(account)

    let ready = account
    if (account.connection_status !== 'connected') {
      const result = await fxsocketBroker.waitUntilConnected(account.id, {
        onProgress: ({ account: updated }) => upsertBroker(updated),
      })
      ready = result.account
      upsertBroker(ready)
    }
    return ready
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')

    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }

    const validRows = rows.filter(row => validateConnectRow(row) == null)
    if (validRows.length === 0) {
      setError(cf.validationRequired)
      return
    }

    if (validRows.length === 1 && rows.length === 1) {
      const row = validRows[0]!
      const login = row.account_number.trim()
      const server = row.broker_server.trim()
      const duplicate = brokers.find(b => b.account_login === login && b.broker_server === server)
      if (duplicate) {
        setError(t.accountConfig.brokerList.duplicateMtLogin)
        return
      }

      setSaving(true)
      try {
        const ready = await connectSingle(row)
        reset()
        if (onSuccess) onSuccess(ready)
        else onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : cf.connectFailed
        setError(userFacingBrokerConnectError(message, connectErrorLabels, { credentialConnect: true }) || cf.connectFailed)
        setSaving(false)
      }
      return
    }

    setSaving(true)

    try {
      const result = await connectAccountsBatch({
        rows: validRows,
        existingBrokers: brokers,
        activeBrokerCountAtStart: activeBrokerCount,
        maxBrokerAccounts: isAdmin ? null : limits.maxBrokerAccounts,
        getKnownBrokers: () => brokersRef.current,
        onProgress: progress => {
          setBatchRows(progress)
          for (const entry of progress) {
            if (entry.status === 'linked' && entry.account) upsertBroker(entry.account)
          }
        },
      })

      reset()
      onClose()
      onBatchSuccess?.(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(userFacingBrokerConnectError(message, connectErrorLabels, { credentialConnect: true }) || cf.connectFailed)
      setSaving(false)
    }
  }

  if (!open) return null

  const selectedPlatform = rows[0]?.platform ?? 'MT5'
  const title = interpolate(cf.title, { platform: selectedPlatform })
  const validCount = countValidRows(rows)
  const isMulti = rows.length > 1 || validCount > 1
  const serverPlatformMismatch = rows
    .map(row => {
      const inferred = inferServerPlatform(row.broker_server)
      return inferred && inferred !== row.platform ? inferred : null
    })
    .find(Boolean) ?? null
  const connectStepMessage = connectStep === 2
    ? cf.connectingStepSlow
    : connectStep === 1
      ? interpolate(cf.connectingStepTerminal, { platform: selectedPlatform })
      : interpolate(cf.connectingStepLinking, { platform: selectedPlatform })
  const submitLabel = isMulti
    ? interpolate(cf.connectMultipleButton, { count: String(validCount) })
    : cf.connectButton

  return (
    <>
      <div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
        onMouseDown={onOverlayMouseDown}
        onClick={onOverlayClick}
      >
        <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm animate-in" />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-trading-account-title"
          className="relative flex max-h-[min(92dvh,56rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl animate-modal-in dark:bg-neutral-900"
        >
          <div className="shrink-0 px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2
                  id="connect-trading-account-title"
                  className="text-lg font-semibold text-neutral-900 dark:text-neutral-50"
                >
                  {title}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setBulkUploadOpen(true)}
                  disabled={saving}
                >
                  {cf.uploadAccountsButton}
                </Button>
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={saving}
                  aria-label={t.common.cancel}
                  className="rounded-xl p-3 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>
            </div>
          </div>

          <div className="mx-6 h-px bg-neutral-100 dark:bg-neutral-800 sm:mx-8" />

          <div className="relative min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
            {error ? <PaywallErrorAlert message={error} className="mb-4" /> : null}

            <form onSubmit={handleSubmit} className={clsx('space-y-4', saving && 'pointer-events-none opacity-60')}>
              <div className="space-y-2">
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {cf.platformLabel}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(['MT5', 'MT4'] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setPlatform(option)}
                      aria-pressed={selectedPlatform === option}
                      className={clsx(
                        'rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                        selectedPlatform === option
                          ? 'border-teal-500 bg-teal-50 text-teal-900 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-100'
                          : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-700',
                      )}
                    >
                      {option === 'MT5' ? cf.platformMt5 : cf.platformMt4}
                    </button>
                  ))}
                </div>
              </div>

              {serverPlatformMismatch ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                  <p>
                    {serverPlatformMismatch === 'MT4'
                      ? t.accountConfig.brokerList.platformServerMismatchMt4
                      : t.accountConfig.brokerList.platformServerMismatchMt5}
                  </p>
                  <button
                    type="button"
                    onClick={() => setPlatform(serverPlatformMismatch)}
                    className="mt-2 font-medium text-teal-700 underline underline-offset-2 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
                  >
                    {serverPlatformMismatch === 'MT4' ? cf.platformMt4 : cf.platformMt5}
                  </button>
                </div>
              ) : null}

              {rows.map((row, index) => (
                <div
                  key={index}
                  className="space-y-3 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      {interpolate(cf.accountRowTitle, { index: String(index + 1) })}
                    </p>
                    {rows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        aria-label={cf.removeRowAria}
                        className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-error-600 dark:hover:bg-neutral-800"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>

                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: selectedPlatform })}
                    value={row.label}
                    onChange={event => setRowField(index, 'label', event.target.value)}
                  />

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input
                      label={cf.mtLoginLabel}
                      placeholder={cf.mtLoginPlaceholder}
                      value={row.account_number}
                      onChange={event => setRowField(index, 'account_number', event.target.value)}
                      required
                    />
                    <PasswordInput
                      label={cf.passwordLabel}
                      placeholder={cf.passwordPlaceholder}
                      value={row.account_password}
                      onChange={event => setRowField(index, 'account_password', event.target.value)}
                      hint={cf.passwordHint}
                      required
                    />
                  </div>

                  <MtCompanyServerPicker
                    value={row.broker_server}
                    onChange={next => setRowField(index, 'broker_server', next)}
                    platform={selectedPlatform}
                    hint={index === 0 ? cf.brokerServerHint : undefined}
                    required
                  />
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={addRow} disabled={saving}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  {cf.addMoreButton}
                </Button>
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="submit" loading={saving} size="sm" disabled={validCount === 0}>
                  {submitLabel}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                  {t.common.cancel}
                </Button>
              </div>
            </form>

            {saving && batchRows.length > 0 ? (
              <ConnectAccountsBatchProgress title={bc.connectingTitle} rows={batchRows} copy={bc} />
            ) : null}

            {saving && batchRows.length === 0 ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white/90 px-8 text-center dark:bg-neutral-900/90"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-10 w-10 animate-spin text-teal-600 dark:text-teal-400" />
                <div>
                  <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {cf.connectingTitle}
                  </p>
                  <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                    {connectStepMessage}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <BulkUploadAccountsModal
        open={bulkUploadOpen}
        onClose={() => setBulkUploadOpen(false)}
        onBatchComplete={result => {
          setBulkUploadOpen(false)
          handleClose()
          onBatchSuccess?.(result)
        }}
      />
    </>
  )
}
