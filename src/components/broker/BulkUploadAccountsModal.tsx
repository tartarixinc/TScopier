import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import clsx from 'clsx'
import { Download, Upload, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { interpolate } from '../../i18n/interpolate'
import {
  connectAccountsBatch,
  downloadConnectAccountsTemplate,
  parseConnectAccountsCsv,
  resolveActiveBrokerCount,
  type BulkConnectResult,
  type BulkConnectRowProgress,
} from '../../lib/bulkConnectBrokers'
import type { ConnectTradingAccountForm } from '../../lib/connectTradingAccountForm'
import { PaywallErrorAlert } from '../billing/PaywallErrorAlert'
import { Button } from '../ui/Button'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { ConnectAccountsBatchProgress } from './ConnectAccountsBatchProgress'

type BulkUploadAccountsModalProps = {
  open: boolean
  onClose: () => void
  onBatchComplete?: (result: BulkConnectResult) => void
}

export function BulkUploadAccountsModal({ open, onClose, onBatchComplete }: BulkUploadAccountsModalProps) {
  const t = useT()
  const bc = t.accountConfig.bulkConnect
  const pw = t.pricing.paywall
  const { brokers, upsertBroker } = useBrokerAccounts()
  const { hasActiveSubscription, limits, usage, isAdmin } = useSubscription()
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const brokersRef = useRef(brokers)
  brokersRef.current = brokers

  const [error, setError] = useState('')
  const [parseErrors, setParseErrors] = useState<Array<{ line: number; message: string }>>([])
  const [previewRows, setPreviewRows] = useState<ConnectTradingAccountForm[]>([])
  const [batchRows, setBatchRows] = useState<BulkConnectRowProgress[]>([])
  const [connecting, setConnecting] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const reset = useCallback(() => {
    setError('')
    setParseErrors([])
    setPreviewRows([])
    setBatchRows([])
    setConnecting(false)
    setDragOver(false)
  }, [])

  const handleClose = useCallback(() => {
    if (connecting) return
    reset()
    onClose()
  }, [connecting, onClose, reset])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, handleClose)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !connecting) handleClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, handleClose, connecting])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const ingestCsvText = useCallback((text: string) => {
    setError('')
    const parsed = parseConnectAccountsCsv(text)
    setParseErrors(parsed.errors)
    setPreviewRows(parsed.rows)
    if (parsed.rows.length === 0 && parsed.errors.length === 0) {
      setError(bc.noValidRows)
    }
  }, [bc.noValidRows])

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      setError('Please upload a CSV file.')
      return
    }
    const text = await file.text()
    ingestCsvText(text)
  }, [ingestCsvText])

  const onFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) await handleFile(file)
    event.target.value = ''
  }, [handleFile])

  const onDrop = useCallback(async (event: DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) await handleFile(file)
  }, [handleFile])

  const slotsAvailable = isAdmin
    ? previewRows.length
    : Math.max(0, limits.maxBrokerAccounts - resolveActiveBrokerCount(brokers, usage.brokerAccounts))

  const handleConnect = async () => {
    setError('')
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (previewRows.length === 0) {
      setError(bc.noValidRows)
      return
    }
    if (!isAdmin && slotsAvailable <= 0) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }

    setConnecting(true)

    try {
      const result = await connectAccountsBatch({
        rows: previewRows,
        existingBrokers: brokers,
        activeBrokerCountAtStart: resolveActiveBrokerCount(brokers, usage.brokerAccounts),
        maxBrokerAccounts: isAdmin ? null : limits.maxBrokerAccounts,
        getKnownBrokers: () => brokersRef.current,
        onProgress: rows => {
          setBatchRows(rows)
          for (const row of rows) {
            if (row.status === 'linked' && row.account) {
              upsertBroker(row.account)
            }
          }
        },
      })

      reset()
      onClose()
      onBatchComplete?.(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : bc.statusFailed)
      setConnecting(false)
    }
  }

  if (!open) return null

  const connectDisabled = connecting || previewRows.length === 0

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm animate-in" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-upload-accounts-title"
        className="relative flex max-h-[min(92dvh,56rem)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl animate-modal-in dark:bg-neutral-900"
      >
        <div className="shrink-0 px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2
                id="bulk-upload-accounts-title"
                className="text-lg font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {bc.title}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{bc.securityNote}</p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              disabled={connecting}
              aria-label={t.common.cancel}
              className="shrink-0 rounded-xl p-3 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        <div className="mx-6 h-px bg-neutral-100 dark:bg-neutral-800 sm:mx-8" />

        <div className="relative min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
          {error ? <PaywallErrorAlert message={error} className="mb-4" /> : null}

          <div className={clsx('space-y-4', connecting && 'pointer-events-none opacity-60')}>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => downloadConnectAccountsTemplate()}>
                <Download className="mr-1.5 h-4 w-4" />
                {bc.downloadTemplate}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-1.5 h-4 w-4" />
                {bc.uploadCsv}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFileChange}
              />
            </div>

            <div
              onDragOver={event => {
                event.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={clsx(
                'rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors',
                dragOver
                  ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-950/20'
                  : 'border-neutral-200 dark:border-neutral-700',
              )}
            >
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{bc.uploadHint}</p>
            </div>

            {parseErrors.length > 0 ? (
              <ul className="space-y-1 rounded-xl border border-error-200 bg-error-50 px-3 py-2 text-xs text-error-700 dark:border-error-900 dark:bg-error-950/30 dark:text-error-300">
                {parseErrors.map(err => (
                  <li key={`${err.line}-${err.message}`}>
                    {interpolate(bc.parseErrorLine, { line: String(err.line), message: err.message })}
                  </li>
                ))}
              </ul>
            ) : null}

            {previewRows.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-medium text-neutral-900 dark:text-neutral-50">{bc.previewTitle}</p>
                <div className="overflow-x-auto rounded-xl border border-neutral-100 dark:border-neutral-800">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
                      <tr>
                        <th className="px-3 py-2">{bc.colLabel}</th>
                        <th className="px-3 py-2">{bc.colPlatform}</th>
                        <th className="px-3 py-2">{bc.colServer}</th>
                        <th className="px-3 py-2">{bc.colLogin}</th>
                        <th className="px-3 py-2">{bc.colPassword}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, index) => (
                        <tr key={`${row.platform}-${row.account_number}-${row.broker_server}-${index}`} className="border-t border-neutral-100 dark:border-neutral-800">
                          <td className="px-3 py-2">{row.label || '—'}</td>
                          <td className="px-3 py-2">{row.platform}</td>
                          <td className="px-3 py-2">{row.broker_server}</td>
                          <td className="px-3 py-2">{row.account_number}</td>
                          <td className="px-3 py-2 font-mono text-xs">{'•'.repeat(Math.min(8, row.account_password.length || 4))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="flex gap-2 pt-2">
              <Button type="button" size="sm" loading={connecting} disabled={connectDisabled} onClick={() => void handleConnect()}>
                {interpolate(bc.connectCount, { count: String(previewRows.length) })}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={connecting}>
                {t.common.cancel}
              </Button>
            </div>
          </div>

          {connecting && batchRows.length > 0 ? (
            <ConnectAccountsBatchProgress title={bc.connectingTitle} rows={batchRows} copy={bc} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
