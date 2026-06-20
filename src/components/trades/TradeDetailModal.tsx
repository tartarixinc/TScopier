import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  Minus,
  Radio,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import type { MtTrade } from '../../lib/fxsocketBroker'
import {
  formatSignalInstructions,
  resolveTradeSignalContext,
  type TradeSignalContext,
} from '../../lib/tradeSignalLink'
import {
  formatTradeLots,
  formatTradePrice,
  getTradeDisplayMeta,
} from '../../lib/tradeDisplay'
import { Badge } from '../ui/Badge'

interface TradeDetailModalProps {
  trade: MtTrade | null
  userId: string | undefined
  onClose: () => void
}

export function TradeDetailModal({ trade, userId, onClose }: TradeDetailModalProps) {
  const t = useT()
  const tr = t.trades
  const panelRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [context, setContext] = useState<TradeSignalContext | null | undefined>(undefined)

  useEffect(() => {
    if (!trade) {
      setContext(undefined)
      setLoadError('')
      setLoading(false)
      return
    }
    if (!userId) {
      setContext(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError('')
    setContext(undefined)

    void (async () => {
      try {
        const result = await resolveTradeSignalContext(userId, trade)
        if (!cancelled) setContext(result)
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
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [trade, onClose])

  const display = useMemo(() => (trade ? getTradeDisplayMeta(trade) : null), [trade])

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
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2 id="trade-detail-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
              {trade.symbol || '—'}
            </h2>
            <p className="text-xs text-neutral-400 tabular-nums">#{trade.ticket}</p>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label={tr.close}
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{tr.tradeSummary}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={display.status.variant} size="sm">{statusLabel}</Badge>
              <span
                className={clsx(
                  'inline-flex items-center gap-1 text-sm font-medium',
                  display.isBuy && 'text-success-600',
                  display.isSell && 'text-error-600',
                  !display.isBuy && !display.isSell && 'text-neutral-500',
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
                    ? 'text-neutral-400'
                    : display.profit > 0
                      ? 'text-success-600'
                      : display.profit < 0
                        ? 'text-error-600'
                        : 'text-neutral-500',
                )}
              >
                {display.profit === null
                  ? '—'
                  : `${display.profit > 0 ? '+' : ''}${display.profit.toFixed(2)}`}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colBroker}</dt>
                <dd className="text-neutral-700 dark:text-neutral-300 mt-0.5 truncate" title={display.broker}>
                  {display.broker}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colLots}</dt>
                <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">
                  {formatTradeLots(trade.lot_size)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colEntry}</dt>
                <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">
                  {formatTradePrice(trade.entry_price)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colTime}</dt>
                <dd className="text-neutral-600 dark:text-neutral-400 mt-0.5">{display.timeLabel}</dd>
              </div>
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colSl}</dt>
                <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">
                  {formatTradePrice(trade.sl)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400 uppercase tracking-wide">{tr.colTp}</dt>
                <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">
                  {formatTradePrice(trade.tp)}
                </dd>
              </div>
            </dl>
          </section>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-500 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {tr.loadingSignal}
            </div>
          ) : loadError ? (
            <p className="text-sm text-error-600 dark:text-error-400">{loadError}</p>
          ) : context === null || !context ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 rounded-xl bg-neutral-50 dark:bg-neutral-800/40 px-4 py-3">
              {tr.noLinkedSignal}
            </p>
          ) : (
            <>
              <section className="rounded-xl border border-teal-200/80 dark:border-teal-900/60 bg-teal-50/40 dark:bg-teal-950/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                  <p className="text-xs font-semibold uppercase tracking-wide text-teal-800 dark:text-teal-300">
                    {tr.signalChannel}
                  </p>
                </div>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
                  {channelLabel ?? '—'}
                </p>
                <p className="text-xs text-neutral-500 tabular-nums">
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

              {messageBody ? (
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    {tr.telegramMessage}
                  </p>
                  <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/30 px-4 py-3">
                    {messageBody}
                  </p>
                  {context.signal.raw_image_url ? (
                    <a
                      href={context.signal.raw_image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-600 dark:text-teal-400 hover:underline"
                    >
                      {context.signal.raw_image_url}
                    </a>
                  ) : null}
                </section>
              ) : null}

              {instructionLines.length > 0 ? (
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    {tr.parsedInstruction}
                  </p>
                  <dl className="rounded-xl border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800">
                    {instructionLines.map(line => (
                      <div key={line.label} className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                        <dt className="text-neutral-500 shrink-0">{line.label}</dt>
                        <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium tabular-nums">
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
    </div>
  )
}
