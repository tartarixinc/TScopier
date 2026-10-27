import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  Minus,
  Radio,
  Repeat,
  TriangleAlert,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useAssistant } from '../../context/useAssistant'
import { supabase } from '../../lib/supabase'
import {
  fetchMirrorCopyAttribution,
  type MirrorCopyAttribution,
} from '../../lib/mirrorCopyAttribution'
import {
  canRequestMirrorClose,
  requestMirrorCopyClose,
  waitForMirrorCopyClosed,
} from '../../lib/mirrorCopyClose'
import {
  fetchPlanFallbackReason,
  isTpSplitSkippedReason,
  staleEntryNotice,
} from '../../lib/tradeExecutionNotes'
import type { MtTrade } from '../../lib/fxsocketBroker'
import {
  formatSignalInstructions,
  resolveTradeSignalContext,
  type TradeSignalContext,
} from '../../lib/tradeSignalLink'
import {
  fetchTradeCloseReason,
  resolveTradeCloseReason,
  tradeCloseReasonLabel,
  type TradeCloseReasonCode,
} from '../../lib/tradeCloseReason'
import {
  fetchBrokerFailuresForTrade,
  formatBrokerFailureRow,
  getTradeFailureDisplayFromLog,
  type CopierBrokerFailureRow,
} from '../../lib/copierLogDetail'
import { buildTradeFailureAssistantPrompt } from '../../lib/tradeFailureDisplay'
import {
  formatTradeLots,
  formatTradePrice,
  getTradeDisplayMeta,
} from '../../lib/tradeDisplay'
import { formatBidAskLine } from '../../lib/tradeLiveQuote'
import { useTradeLiveQuote } from '../../hooks/useTradeLiveQuote'
import {
  getManualBrokerOverrideWarningForTrade,
  manualOverrideManageSignalUrl,
  type ManualBrokerOverrideWarningMaps,
} from '../../lib/manualBrokerOverrideWarnings'
import { ManualBrokerOverrideWarningNotice } from './ManualBrokerOverrideWarning'
import { Badge } from '../ui/Badge'
import { ReportTradeModal } from './ReportTradeModal'

interface TradeDetailModalProps {
  trade: MtTrade | null
  userId: string | undefined
  manualOverrideWarningMaps?: ManualBrokerOverrideWarningMaps
  onClose: () => void
}

export function TradeDetailModal({ trade, userId, manualOverrideWarningMaps, onClose }: TradeDetailModalProps) {
  const t = useT()
  const assistant = useAssistant()
  const tr = t.trades
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [context, setContext] = useState<TradeSignalContext | null | undefined>(undefined)
  const [closeReasonCode, setCloseReasonCode] = useState<TradeCloseReasonCode | null>(null)
  const [brokerFailures, setBrokerFailures] = useState<CopierBrokerFailureRow[]>([])
  const [mirrorAttribution, setMirrorAttribution] = useState<MirrorCopyAttribution | null>(null)
  const [mirrorCloseStatus, setMirrorCloseStatus] = useState<'idle' | 'working' | 'done' | 'timeout' | 'error'>('idle')
  const [mirrorCloseError, setMirrorCloseError] = useState<string | null>(null)
  const [planFallbackReason, setPlanFallbackReason] = useState<string | null>(null)
  const [showReport, setShowReport] = useState(false)

  useEffect(() => {
    if (!trade) {
      setContext(undefined)
      setCloseReasonCode(null)
      setLoadError('')
      setLoading(false)
      setBrokerFailures([])
      setMirrorAttribution(null)
      setMirrorCloseStatus('idle')
      setMirrorCloseError(null)
      setPlanFallbackReason(null)
      return
    }
    if (!userId) {
      setContext(null)
      setCloseReasonCode(null)
      setBrokerFailures([])
      setMirrorAttribution(null)
      setMirrorCloseStatus('idle')
      setMirrorCloseError(null)
      setPlanFallbackReason(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError('')
    setContext(undefined)
    setCloseReasonCode(null)
    setBrokerFailures([])
    setMirrorAttribution(null)
    setMirrorCloseStatus('idle')
    setMirrorCloseError(null)
    setPlanFallbackReason(null)

    void (async () => {
      try {
        const [result, storedCloseReason, mirror] = await Promise.all([
          resolveTradeSignalContext(userId, trade),
          trade.status === 'closed'
            ? fetchTradeCloseReason(supabase, {
                userId,
                brokerAccountId: trade.broker_id,
                ticket: trade.ticket,
              }).catch(() => null)
            : Promise.resolve(null),
          fetchMirrorCopyAttribution(supabase, userId, trade.comment).catch(() => null),
        ])
        if (cancelled) return
        setCloseReasonCode(resolveTradeCloseReason(storedCloseReason, trade))
        setContext(result)
        setMirrorAttribution(mirror)
        if (result?.signal) {
          const [failures, fallbackReason] = await Promise.all([
            fetchBrokerFailuresForTrade(supabase, {
              userId,
              signalId: result.signal.id,
              brokerAccountId: trade.broker_id,
            }),
            fetchPlanFallbackReason(supabase, {
              userId,
              signalId: result.signal.id,
              brokerAccountId: trade.broker_id,
            }),
          ])
          if (cancelled) return
          setBrokerFailures(failures)
          setPlanFallbackReason(fallbackReason)
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : tr.loadSignalError)
          setContext(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [trade, userId, tr.loadSignalError])

  useEffect(() => {
    if (!trade) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [trade, onClose])

  const display = useMemo(() => (trade ? getTradeDisplayMeta(trade) : null), [trade])
  const structuredBrokerFailure = useMemo(
    () => brokerFailures.map(row => getTradeFailureDisplayFromLog(row)).find(Boolean) ?? null,
    [brokerFailures],
  )
  const liveQuote = useTradeLiveQuote(trade, userId)
  const bidAskLine = formatBidAskLine(liveQuote.quote)

  const closeReasonSentence = useMemo(() => {
    if (!trade || trade.status !== 'closed' || !closeReasonCode) return null
    const price =
      closeReasonCode === 'stop_loss'
        ? formatTradePrice(trade.sl)
        : closeReasonCode === 'take_profit'
          ? formatTradePrice(trade.tp)
          : undefined
    return tradeCloseReasonLabel(closeReasonCode, tr, { price })
  }, [trade, closeReasonCode, tr])

  const linkedSignalId = context?.signal?.id

  const manualOverrideWarning = useMemo(() => {
    if (!trade || !manualOverrideWarningMaps) return null
    return getManualBrokerOverrideWarningForTrade(manualOverrideWarningMaps, trade, linkedSignalId)
  }, [manualOverrideWarningMaps, trade, linkedSignalId])

  const handleManage = () => {
    if (!linkedSignalId) return
    onClose()
    navigate(`/manage-signals?edit=${linkedSignalId}`)
  }

  const handleWarningManage = () => {
    onClose()
    navigate(manualOverrideWarning?.actionUrl || manualOverrideManageSignalUrl(linkedSignalId))
  }

  const handleViewCopierLogs = () => {
    onClose()
    navigate('/copier-logs')
  }

  const handleCloseCopy = async () => {
    const mappingId = mirrorAttribution?.mappingId
    if (!mappingId || mirrorCloseStatus === 'working') return
    const confirmText = tr.closeCopyConfirm
      ?? 'Close this copied trade on the slave account? The master trade stays open — this copy will not be reopened.'
    if (!window.confirm(confirmText)) return
    setMirrorCloseStatus('working')
    setMirrorCloseError(null)
    try {
      const request = await requestMirrorCopyClose(supabase, mappingId)
      if (request.error) {
        setMirrorCloseStatus('error')
        setMirrorCloseError(request.error)
        return
      }
      if (!request.applied) {
        // Nothing changed: the copy is already closed (or closing was refused).
        setMirrorCloseStatus('done')
        setMirrorAttribution(prev => (prev ? { ...prev, mappingState: 'closed' } : prev))
        return
      }
      setMirrorAttribution(prev => (prev ? { ...prev, mappingState: 'closing' } : prev))
      const wait = await waitForMirrorCopyClosed(supabase, mappingId)
      if (wait.outcome === 'closed') {
        setMirrorCloseStatus('done')
        setMirrorAttribution(prev => (prev ? { ...prev, mappingState: 'closed' } : prev))
      } else if (wait.outcome === 'read-error') {
        setMirrorCloseStatus('error')
        setMirrorCloseError(wait.error)
      } else {
        setMirrorCloseStatus('timeout')
      }
    } catch (e) {
      setMirrorCloseStatus('error')
      setMirrorCloseError(e instanceof Error ? e.message : String(e))
    }
  }

  const askAssistantAboutFailure = () => {
    if (!structuredBrokerFailure) return
    assistant.persistMessages(prev => [
      ...prev,
      { role: 'user', content: buildTradeFailureAssistantPrompt(structuredBrokerFailure) },
    ])
    assistant.openAssistant()
  }

  const askAssistantExplainSignal = () => {
    if (!trade) return
    const parsed = context?.signal?.parsed_data as Record<string, unknown> | null
    const ctx = [
      `Signal ID: ${context?.signal?.id}`,
      `Status: ${context?.signal?.status}`,
      `Symbol: ${trade.symbol}`,
      `Action: ${parsed?.action ?? '—'}`,
      parsed?.entry_price ? `Entry price: ${parsed.entry_price}` : '',
      parsed?.sl ? `Stop loss: ${parsed.sl}` : '',
      Array.isArray(parsed?.tp) ? `Take profit: ${parsed.tp.join(', ')}` : '',
      context?.signal?.skip_reason ? `Skip reason: ${context.signal.skip_reason}` : '',
      rawMessage ? `\nOriginal Telegram message:\n${rawMessage}` : '',
    ].filter(Boolean).join('\n')
    assistant.setPendingAutoSend(`Please explain what happened with this trade signal in plain English.\n\n${ctx}`)
    assistant.openAssistant()
  }

  const instructionLines = useMemo(() => {
    if (!context?.signal) return []
    return formatSignalInstructions(context.signal.parsed_data, context.signal.raw_message, {
      action: tr.instructionAction,
      symbol: tr.instructionSymbol,
      entry: tr.instructionEntry,
      entryZone: tr.instructionEntryZone,
      sl: tr.instructionSl,
      tp: tr.instructionTp,
      lotSize: tr.instructionLotSize,
      message: tr.instructionMessage,
    })
  }, [context?.signal, tr])

  if (!trade || !display) return null

  const staleEntry = staleEntryNotice(
    (context?.signal?.parsed_data as Record<string, unknown> | null)?.entry_price,
    trade.entry_price,
  )
  const showTpSplitNote = isTpSplitSkippedReason(planFallbackReason)

  const channelLabel = (() => {
    const ch = context?.channel
    if (!ch) return null
    const name = ch.display_name?.trim()
    const username = ch.channel_username?.trim().replace(/^@/, '')
    if (name && username) return `${name} (@${username})`
    if (name) return name
    if (username) return `@${username}`
    return null
  })()

  const rawMessage = context?.signal.raw_message?.trim()
  const messageBody = rawMessage || (context?.signal.raw_image_url ? tr.imageSignal : '')

  const statusLabel =
    trade.status === 'open' ? tr.statusOpen : trade.status === 'closed' ? tr.statusClosed : display.status.label

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-detail-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={tr.close}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2 id="trade-detail-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
              {trade.symbol || '—'}
            </h2>
            <p className="text-xs text-neutral-900 dark:text-neutral-50 tabular-nums">#{trade.ticket}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowReport(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              {tr.report}
            </button>
            <button
              type="button"
              disabled={!linkedSignalId}
              onClick={handleManage}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              {tr.manage}
            </button>
            <button
              type="button"
              className="p-2 rounded-lg text-neutral-900 dark:text-neutral-50 hover:text-neutral-900 dark:hover:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={tr.close}
              onClick={onClose}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <section className="rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-900 dark:text-neutral-50">{tr.tradeSummary}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={display.status.variant} size="sm">{statusLabel}</Badge>
              <span
                className={clsx(
                  'inline-flex items-center gap-1 text-sm font-medium',
                  display.isBuy && 'text-success-600',
                  display.isSell && 'text-error-600',
                  !display.isBuy && !display.isSell && 'text-neutral-900 dark:text-neutral-50',
                )}
              >
                {display.isBuy ? (
                  <ArrowUpRight className="w-3.5 h-3.5" />
                ) : display.isSell ? (
                  <ArrowDownRight className="w-3.5 h-3.5" />
                ) : (
                  <Minus className="w-3.5 h-3.5" />
                )}
                {display.directionLabel}
              </span>
              <span
                className={clsx(
                  'text-sm font-semibold tabular-nums ml-auto',
                  display.profit === null
                    ? 'text-neutral-900 dark:text-neutral-50'
                    : display.profit > 0
                      ? 'text-success-600'
                      : display.profit < 0
                        ? 'text-error-600'
                        : 'text-neutral-900 dark:text-neutral-50',
                )}
              >
                {display.profit === null
                  ? '—'
                  : `${display.profit > 0 ? '+' : ''}${display.profit.toFixed(2)}`}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colBroker}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 mt-0.5 truncate" title={display.broker}>
                  {display.broker}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colLots}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 tabular-nums mt-0.5">
                  {formatTradeLots(trade.lot_size)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colEntry}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 tabular-nums mt-0.5">
                  {formatTradePrice(trade.entry_price)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colTime}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 mt-0.5">{display.timeLabel}</dd>
              </div>
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colSl}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 tabular-nums mt-0.5">
                  {formatTradePrice(trade.sl)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colTp}</dt>
                <dd className="text-neutral-900 dark:text-neutral-50 tabular-nums mt-0.5">
                  {formatTradePrice(trade.tp)}
                </dd>
              </div>
              {trade.status === 'open' ? (
                <div className="col-span-2">
                  <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colCurrent}</dt>
                  <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-neutral-900 dark:text-neutral-50 tabular-nums font-semibold">
                      {liveQuote.price != null
                        ? formatTradePrice(liveQuote.price)
                        : liveQuote.loading
                          ? '…'
                          : '—'}
                    </span>
                    {bidAskLine ? (
                      <span className="text-neutral-900 dark:text-neutral-50 tabular-nums text-[11px]">{bidAskLine}</span>
                    ) : null}
                    {liveQuote.loading ? (
                      <Loader2 className="w-3 h-3 animate-spin text-neutral-900 dark:text-neutral-50" aria-hidden="true" />
                    ) : null}
                  </dd>
                </div>
              ) : (
                <div className="col-span-2">
                  <dt className="text-neutral-900 dark:text-neutral-50 uppercase tracking-wide">{tr.colClosePrice}</dt>
                  <dd className="text-neutral-900 dark:text-neutral-50 tabular-nums mt-0.5 font-semibold">
                    {formatTradePrice(trade.close_price)}
                  </dd>
                </div>
              )}
              {closeReasonSentence ? (
                <div className="col-span-2 border-t border-neutral-100 dark:border-neutral-800 pt-2.5">
                  <dt className="text-neutral-400 uppercase tracking-wide">{tr.closeReason}</dt>
                  <dd className="text-sm text-neutral-700 dark:text-neutral-300 mt-1 leading-relaxed">
                    {closeReasonSentence}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          {mirrorAttribution ? (
            <section className="rounded-xl border border-teal-200/80 dark:border-teal-900/60 bg-teal-50/40 dark:bg-teal-950/20 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Repeat className="w-4 h-4 text-green-400 shrink-0" aria-hidden />
                <p className="text-xs font-semibold uppercase tracking-wide text-teal-800 dark:text-teal-300">
                  {tr.copiedFromMasterTitle ?? 'Mirror copy'}
                </p>
              </div>
              <p className="text-sm text-neutral-900 dark:text-neutral-50">
                {interpolate(tr.copiedFromMaster ?? 'Copied from master account {login}', {
                  login: mirrorAttribution.masterLogin,
                })}
              </p>
              {trade.status === 'open' && mirrorAttribution.mappingId ? (
                <div className="pt-1 space-y-1.5">
                  {mirrorCloseStatus === 'done' ? (
                    <p className="text-sm font-medium text-teal-800 dark:text-teal-300">
                      {tr.closeCopyDone ?? 'Copy closed'}
                    </p>
                  ) : mirrorCloseStatus === 'timeout' ? (
                    <>
                      <p className="text-sm text-neutral-900 dark:text-neutral-50">
                        {tr.closeCopyTimeout
                          ?? 'Close requested — the worker closes it within about a minute. Refresh the page if it still shows open.'}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleCloseCopy()}
                        disabled={!canRequestMirrorClose(mirrorAttribution.mappingState)}
                        className="rounded-lg border border-teal-300 dark:border-teal-800 px-3 py-1.5 text-sm font-medium text-teal-900 dark:text-teal-200 hover:bg-teal-100/70 dark:hover:bg-teal-900/40 disabled:opacity-50"
                      >
                        {tr.closeCopyRetry ?? 'Retry close'}
                      </button>
                    </>
                  ) : mirrorCloseStatus === 'error' ? (
                    <>
                      <p className="text-sm text-error-700 dark:text-error-300">
                        {mirrorCloseError
                          ? interpolate(tr.closeCopyError ?? 'Could not close the copy: {error}', { error: mirrorCloseError })
                          : (tr.closeCopyErrorFallback ?? 'Could not close the copy. Try again.')}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleCloseCopy()}
                        className="rounded-lg border border-teal-300 dark:border-teal-800 px-3 py-1.5 text-sm font-medium text-teal-900 dark:text-teal-200 hover:bg-teal-100/70 dark:hover:bg-teal-900/40"
                      >
                        {tr.closeCopyRetry ?? 'Retry close'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleCloseCopy()}
                      disabled={mirrorCloseStatus === 'working' || !canRequestMirrorClose(mirrorAttribution.mappingState)}
                      className="inline-flex items-center gap-2 rounded-lg border border-teal-300 dark:border-teal-800 px-3 py-1.5 text-sm font-medium text-teal-900 dark:text-teal-200 hover:bg-teal-100/70 dark:hover:bg-teal-900/40 disabled:opacity-50"
                    >
                      {mirrorCloseStatus === 'working' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                      ) : null}
                      {mirrorCloseStatus === 'working'
                        ? (tr.closeCopyWorking ?? 'Closing copy…')
                        : (tr.closeCopy ?? 'Close copy')}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {staleEntry != null || showTpSplitNote ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 space-y-2 dark:border-amber-900/60 dark:bg-amber-950/25">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                  {tr.execNotesTitle ?? 'Execution notes'}
                </p>
              </div>
              <ul className="space-y-1.5">
                {showTpSplitNote ? (
                  <li className="text-sm text-neutral-900 dark:text-neutral-50">
                    {tr.execNoteTpSplit
                      ?? 'Some partial take-profits were skipped — this lot is too small to split (those slices would be below the broker minimum). The remaining take-profits still apply.'}
                  </li>
                ) : null}
                {staleEntry != null ? (
                  <li className="text-sm text-neutral-900 dark:text-neutral-50">
                    {interpolate(
                      tr.execNoteStaleEntry
                        ?? 'The signal entry was {entry} but the trade opened at {fill} — price had already moved when the order was sent.',
                      {
                        entry: formatTradePrice(staleEntry.signalEntry),
                        fill: formatTradePrice(staleEntry.fillPrice),
                      },
                    )}
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {manualOverrideWarning ? (
            <ManualBrokerOverrideWarningNotice
              warning={manualOverrideWarning}
              onManageSignal={handleWarningManage}
            />
          ) : null}

          {brokerFailures.length > 0 ? (
            <section className="rounded-xl border border-error-200 dark:border-error-900/60 bg-error-50/60 dark:bg-error-950/20 p-4 space-y-2.5">
              <div className="flex items-center gap-2">
                <TriangleAlert className="w-4 h-4 text-error-600 dark:text-error-400 shrink-0" />
                <p className="text-xs font-semibold uppercase tracking-wide text-error-800 dark:text-error-300">
                  {tr.brokerErrorTitle}
                </p>
              </div>
              <p className="text-sm text-neutral-900 dark:text-neutral-50">{tr.brokerErrorIntro}</p>
              {structuredBrokerFailure ? (
                <div className="space-y-1 rounded-lg border border-error-200/80 dark:border-error-900/60 bg-white/70 dark:bg-neutral-900/40 px-3 py-2">
                  <p className="text-sm font-semibold text-error-800 dark:text-error-200">
                    {structuredBrokerFailure.title}
                  </p>
                  <p className="text-xs text-neutral-900 dark:text-neutral-50">
                    {structuredBrokerFailure.explanation}
                  </p>
                  {structuredBrokerFailure.recommendedAction ? (
                    <p className="text-xs text-neutral-900 dark:text-neutral-50">
                      {structuredBrokerFailure.recommendedAction}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={askAssistantAboutFailure}
                    className="text-xs font-semibold text-green-500 dark:text-teal-300 hover:underline underline-offset-2"
                  >
                    Ask AI about this issue
                  </button>
                </div>
              ) : null}
              <ul className="space-y-2">
                {brokerFailures.map((failure, idx) => (
                  <li
                    key={`${failure.created_at}-${failure.action}-${idx}`}
                    className="flex gap-2 text-xs"
                  >
                    <span className="text-neutral-900 dark:text-neutral-50 whitespace-nowrap tabular-nums shrink-0 pt-0.5">
                      {new Date(failure.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span
                      className="text-error-700 dark:text-error-300 min-w-0 wrap-break-word"
                      title={failure.error_message ?? undefined}
                    >
                      {formatBrokerFailureRow(failure, t.copierLogs)}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleViewCopierLogs}
                className="text-xs font-semibold text-green-500 dark:text-teal-300 hover:underline underline-offset-2"
              >
                {tr.viewCopierLogs}
              </button>
            </section>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-900 dark:text-neutral-50 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {tr.loadingSignal}
            </div>
          ) : loadError ? (
            <p className="text-sm text-error-600 dark:text-error-400">{loadError}</p>
          ) : context === null || !context ? (
            <p className="text-sm text-neutral-900 dark:text-neutral-50 rounded-xl bg-neutral-50 dark:bg-neutral-800/40 px-4 py-3">
              {tr.noLinkedSignal}
            </p>
          ) : (
            <>
              <section className="rounded-xl border border-teal-200/80 dark:border-teal-900/60 bg-teal-50/40 dark:bg-teal-950/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-green-400 dark:text-green-400 shrink-0" />
                  <p className="text-xs font-semibold uppercase tracking-wide text-teal-800 dark:text-teal-300">
                    {tr.signalChannel}
                  </p>
                </div>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
                  {channelLabel ?? '—'}
                </p>
                <p className="text-xs text-neutral-900 dark:text-neutral-50 tabular-nums">
                  {tr.signalTime}:{' '}
                  {new Date(context.signal.created_at).toLocaleString([], {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </section>

              <button
                type="button"
                onClick={askAssistantExplainSignal}
                className="text-xs font-semibold text-green-500 dark:text-teal-300 hover:underline underline-offset-2"
              >
                {t.copierLogs.detailModal?.explainWithAi ?? 'Explain with AI'}
              </button>

              {messageBody ? (
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-900 dark:text-neutral-50">
                    {tr.telegramMessage}
                  </p>
                  <p className="text-sm text-neutral-900 dark:text-neutral-50 whitespace-pre-wrap rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 bg-neutral-50/80 dark:bg-neutral-800/30 px-4 py-3">
                    {messageBody}
                  </p>
                  {context.signal.raw_image_url ? (
                    <a
                      href={context.signal.raw_image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-green-400 dark:text-green-400 hover:underline"
                    >
                      {context.signal.raw_image_url}
                    </a>
                  ) : null}
                </section>
              ) : null}

              {instructionLines.length > 0 ? (
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-900 dark:text-neutral-50">
                    {tr.parsedInstruction}
                  </p>
                  <dl className="rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 divide-y divide-neutral-100 dark:divide-neutral-800">
                    {instructionLines.map(line => (
                      <div key={line.label} className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                        <dt className="text-neutral-900 dark:text-neutral-50 shrink-0">{line.label}</dt>
                        <dd className="text-neutral-900 dark:text-neutral-50 text-right font-medium tabular-nums">
                          {line.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>

      {showReport && trade && (
        <ReportTradeModal trade={trade} userId={userId} onClose={() => setShowReport(false)} />
      )}
    </div>
  )
}
