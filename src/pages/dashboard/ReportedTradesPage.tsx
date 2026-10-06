import { useMemo } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { useTradeReports } from '../../hooks/useTradeReports'

function categoryLabel(category: string, t: ReturnType<typeof useT>): string {
  switch (category) {
    case 'wrong_entry':
      return t.trades.catWrongEntry
    case 'wrong_sl':
      return t.trades.catWrongSl
    case 'wrong_tp':
      return t.trades.catWrongTp
    case 'wrong_direction':
      return t.trades.catWrongDirection
    case 'wrong_lots':
      return t.trades.catWrongLots
    case 'not_executed':
      return t.trades.catNotExecuted
    default:
      return t.trades.catOther
  }
}

function formatPrice(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return String(value)
}

export function ReportedTradesPage() {
  const t = useT()
  const { user } = useAuth()
  const tr = t.trades
  const { reports, loading, error, refresh } = useTradeReports(user?.id)

  const statusCounts = useMemo(
    () => ({
      all: reports.length,
      open: reports.filter(r => r.status === 'open').length,
      resolved: reports.filter(r => r.status === 'resolved').length,
    }),
    [reports],
  )

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={tr.reportsTitle}
        actions={
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            <RefreshCw className="h-4 w-4" />
            {tr.refresh}
          </button>
        }
      />

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="neutral" size="sm">
          {tr.filterAll}: {statusCounts.all}
        </Badge>
        <Badge variant="warning" size="sm">
          {tr.reportsStatusOpen}: {statusCounts.open}
        </Badge>
        <Badge variant="success" size="sm">
          {tr.reportsStatusResolved}: {statusCounts.resolved}
        </Badge>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {tr.loadingSignal}
        </div>
      ) : error ? (
        <p className="text-sm text-error-600 dark:text-error-400">{error}</p>
      ) : reports.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{tr.reportsEmpty}</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {reports.map(r => (
            <li
              key={r.id}
              className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900/70"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate font-semibold text-neutral-900 dark:text-neutral-50">
                    {r.symbol ?? tr.reportTitle}
                    {r.ticket ? <span className="font-mono text-teal-700 dark:text-teal-300"> #{r.ticket}</span> : null}
                  </p>
                  {r.direction ? (
                    <Badge variant={r.direction === 'buy' ? 'success' : 'error'} size="sm">
                      {r.direction === 'buy' ? 'Buy' : 'Sell'}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {r.category ? (
                    <Badge variant="neutral" size="sm">
                      {categoryLabel(r.category, t)}
                    </Badge>
                  ) : null}
                  <Badge variant={r.status === 'resolved' ? 'success' : 'warning'} size="sm">
                    {r.status === 'resolved' ? tr.reportsStatusResolved : tr.reportsStatusOpen}
                  </Badge>
                </div>
              </div>

              {r.reason ? (
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-300">
                  {r.reason}
                </p>
              ) : null}

              <p className="mt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                {new Date(r.created_at).toLocaleString()}
                {r.broker_label ? ` · ${r.broker_label}` : ''}
                {r.entry_price != null || r.sl != null || r.tp != null || r.lot_size != null ? (
                  <>
                    {' · '}
                    {[
                      r.entry_price != null ? `Entry ${formatPrice(r.entry_price)}` : null,
                      r.sl != null ? `SL ${formatPrice(r.sl)}` : null,
                      r.tp != null ? `TP ${formatPrice(r.tp)}` : null,
                      r.lot_size != null ? `Lot ${formatPrice(r.lot_size)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}