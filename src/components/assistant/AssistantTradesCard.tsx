import { useMemo } from 'react'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'

export type AssistantPosition = {
  status?: string | null
  ticket?: string | null
  symbol?: string | null
  broker?: string | null
  entry_price?: number | null
  sl?: number | null
  tp?: number | null
  lot_size?: number | null
  opened_at?: string | null
  closed_at?: string | null
  profit?: number | null
}

export type AssistantTradeRow = {
  signal_id?: string | null
  time?: string | null
  channel?: string | null
  symbol?: string | null
  action?: string | null
  direction?: string | null
  entry_price?: number | null
  sl?: number | null
  tp?: number | null
  lot_size?: number | null
  status?: string | null
  skip_reason?: string | null
  tickets?: string[]
  failure_count?: number
  errors?: string[]
  legs?: number
  positions?: AssistantPosition[]
}

export type AssistantTradesCardCopy = {
  title: string
  noTrades: string
  ticket: string
  legs: string
  viewDetails: string
  statusExecuted: string
  statusFailed: string
  statusSkipped: string
  statusPending: string
  statusParsed: string
  statusDispatched: string
  statusIgnored: string
  statusError: string
  statusCancelled: string
  positionOpen: string
  positionClosed: string
  reportStatusOpen: string
  reportStatusResolved: string
}

type ParsedResult = {
  trades?: AssistantTradeRow[]
  trade?: AssistantTradeRow
  legs?: AssistantTradeRow[]
  reports?: Array<{
    symbol?: string | null
    direction?: string | null
    ticket?: string | null
    broker?: string | null
    category?: string | null
    reason?: string | null
    status?: string | null
    time?: string | null
  }>
  error?: string
}

function parseResult(result: string): ParsedResult | null {
  try {
    return JSON.parse(result) as ParsedResult
  } catch {
    return null
  }
}

function statusLabel(status: string, copy: AssistantTradesCardCopy): string {
  switch (status) {
    case 'executed':
      return copy.statusExecuted
    case 'failed':
    case 'error':
      return copy.statusFailed
    case 'skipped':
      return copy.statusSkipped
    case 'pending':
      return copy.statusPending
    case 'parsed':
      return copy.statusParsed
    case 'dispatched':
      return copy.statusDispatched
    case 'ignored':
      return copy.statusIgnored
    case 'cancelled':
      return copy.statusCancelled
    default:
      return status
  }
}

function statusStyles(status: string): string {
  switch (status) {
    case 'executed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
    case 'failed':
    case 'error':
      return 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
    case 'skipped':
    case 'ignored':
    case 'cancelled':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
    case 'pending':
    case 'dispatched':
    case 'parsed':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300'
    default:
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
  }
}

function directionBadge(direction: string | null | undefined) {
  const d = (direction ?? '').toLowerCase()
  const isBuy = d === 'buy' || d === 'long'
  const isSell = d === 'sell' || d === 'short'
  if (!isBuy && !isSell) return null
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        isBuy
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
      )}
    >
      {isBuy ? 'Buy' : 'Sell'}
    </span>
  )
}

function formatPrice(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const text = String(value)
  return Number.isInteger(value) ? text : text.replace(/\.?0+$/, '')
}

function LivePositionBadge({
  position,
  copy,
}: {
  position: AssistantPosition
  copy: AssistantTradesCardCopy
}) {
  const status = (position.status ?? '').toLowerCase()
  const isOpen = status === 'open'
  const isClosed = status === 'closed'
  const label = isOpen ? copy.positionOpen : isClosed ? copy.positionClosed : null
  if (!label) return null
  return (
    <span
      className={clsx(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold',
        isOpen
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
      )}
    >
      {label}
    </span>
  )
}

function TradeRow({
  trade,
  copy,
  onClick,
}: {
  trade: AssistantTradeRow
  copy: AssistantTradesCardCopy
  onClick?: () => void
}) {
  const status = trade.status ?? ''
  const symbol = trade.symbol ?? 'Trade'
  const clickable = Boolean(onClick)
  return (
    <li
      className={clsx(
        'rounded-xl border border-neutral-200/65 bg-white p-2.5 dark:border-neutral-800/55 dark:bg-neutral-900/70',
        clickable &&
          'cursor-pointer transition hover:border-teal-300 hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60 dark:hover:border-teal-700 dark:hover:bg-neutral-800/60',
      )}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${copy.viewDetails}: ${symbol}` : undefined}
      title={clickable ? copy.viewDetails : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-neutral-900 dark:text-neutral-50">{symbol}</span>
          {directionBadge(trade.direction)}
          {trade.legs ? (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {copy.legs}: {trade.legs + 1}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {trade.positions?.map((p, i) => (
            <LivePositionBadge key={i} position={p} copy={copy} />
          ))}
          <span
            className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
              statusStyles(status),
            )}
          >
            {statusLabel(status, copy)}
          </span>
          {clickable ? (
            <ChevronRight className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" />
          ) : null}
        </div>
      </div>

      {trade.time ? (
        <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {new Date(trade.time).toLocaleString()}
          {trade.channel ? ` · ${trade.channel}` : ''}
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
        {trade.entry_price != null ? <span>Entry {formatPrice(trade.entry_price)}</span> : null}
        {trade.sl != null ? <span>SL {formatPrice(trade.sl)}</span> : null}
        {trade.tp != null ? <span>TP {formatPrice(trade.tp)}</span> : null}
        {trade.lot_size != null ? <span>Lot {formatPrice(trade.lot_size)}</span> : null}
      </div>

      {trade.tickets?.length ? (
        <p className="mt-1.5 text-[11px] text-neutral-600 dark:text-neutral-300">
          {copy.ticket}:{' '}
          {trade.tickets.map((t, i) => (
            <span key={t} className="font-mono text-teal-700 dark:text-teal-300">
              {i > 0 ? ', ' : ''}#{t}
            </span>
          ))}
        </p>
      ) : null}

      {trade.skip_reason ? (
        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          {trade.skip_reason}
        </p>
      ) : null}

      {trade.errors?.length ? (
        <ul className="mt-1.5 space-y-0.5">
          {trade.errors.slice(0, 2).map((err, i) => (
            <li key={i} className="truncate text-[11px] text-red-600 dark:text-red-400">
              {err}
            </li>
          ))}
          {trade.errors.length > 2 ? (
            <li className="text-[11px] text-neutral-500 dark:text-neutral-400">
              +{trade.errors.length - 2} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

function ReportRow({ report, copy }: { report: NonNullable<ParsedResult['reports']>[number]; copy: AssistantTradesCardCopy }) {
  const resolved = (report.status ?? '').toLowerCase() === 'resolved'
  return (
    <li className="rounded-xl border border-neutral-200/65 bg-white px-3 py-2.5 dark:border-neutral-800/55 dark:bg-neutral-900/70">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-neutral-900 dark:text-neutral-50">
            {report.symbol ?? copy.title}
            {report.ticket ? (
              <span className="font-mono text-teal-700 dark:text-teal-300"> #{report.ticket}</span>
            ) : null}
          </span>
          {directionBadge(report.direction)}
        </div>
        <span
          className={clsx(
            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
            resolved
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
          )}
        >
          {resolved ? copy.reportStatusResolved : copy.reportStatusOpen}
        </span>
      </div>
      {report.reason ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-neutral-600 dark:text-neutral-300">
          {report.reason}
        </p>
      ) : null}
      {report.time && Number.isFinite(Date.parse(report.time)) ? (
        <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {new Date(report.time).toLocaleString()}
          {report.broker ? ` · ${report.broker}` : ''}
        </p>
      ) : null}
    </li>
  )
}

/** Renders trades/legs returned by the assistant's get_recent_trades / get_copier_logs / get_trade_detail tools. */
export function AssistantTradesCard({
  tool,
  result,
  copy,
  onTradeClick,
}: {
  tool: string
  result: string
  copy: AssistantTradesCardCopy
  onTradeClick?: (trade: AssistantTradeRow) => void
}) {
  const data = useMemo(() => parseResult(result), [result])

  const trades = useMemo(() => {
    if (!data) return []
    const rows = data.trades?.length ? data.trades : []
    if (!rows.length && data.trade) rows.push(data.trade)
    if (!rows.length && data.legs?.length) rows.push(...data.legs)
    return rows
  }, [data])

  if (!data || data.error) return null
  if (!trades.length && !data.reports?.length) return null

  return (
    <div className="animate-assistant-msg-in ms-[2.375rem] space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {copy.title}
      </p>
      {trades.length ? (
        <ul className="space-y-2">
          {trades.map(t => (
            <TradeRow
              key={t.signal_id ?? `${tool}-${t.symbol}-${t.time}`}
              trade={t}
              copy={copy}
              onClick={t.signal_id && onTradeClick ? () => onTradeClick(t) : undefined}
            />
          ))}
        </ul>
      ) : null}
      {data.reports?.length ? (
        <ul className="space-y-2">
          {data.reports.map((r, i) => (
            <ReportRow
              key={r.ticket ?? `${r.symbol ?? ''}-${r.time ?? ''}-${i}`}
              report={r}
              copy={copy}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}
