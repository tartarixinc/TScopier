import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useT } from '../../context/LocaleContext'
import { platformIconSrc } from '../../lib/activityRoute'
import {
  fetchProviderCopierDetails,
  type ProviderCopierDetails,
} from '../../lib/socialCopy'
import {
  mirrorSizingLabel,
  mirrorSizingValue,
} from '../../lib/copyRiskTypes'
import { supabase } from '../../lib/supabase'

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-sm text-neutral-600 dark:text-neutral-300">{label}</dt>
      <dd className="max-w-[60%] text-right text-sm font-medium text-neutral-900 dark:text-neutral-50">{value}</dd>
    </div>
  )
}

function MoneyCard({
  label,
  value,
  currency,
}: {
  label: string
  value: number | null
  currency: string | null
}) {
  const { formatMoney } = useFormatMoney()
  return (
    <div className="rounded-2xl border border-neutral-200/70 bg-neutral-50/80 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-900/50">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
        {value == null ? '—' : formatMoney(value)}
      </p>
      {currency ? (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{currency}</p>
      ) : null}
    </div>
  )
}

function statusTone(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'active') return 'success'
  if (status === 'paused' || status === 'pending') return 'warning'
  if (status === 'error' || status === 'emergency_stopped') return 'error'
  return 'neutral'
}

export function CopierDetailsPage() {
  const { subscriptionId } = useParams()
  const navigate = useNavigate()
  const t = useT()
  const copy = t.socialTradingPage
  const [details, setDetails] = useState<ProviderCopierDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!subscriptionId) {
      setDetails(null)
      setLoading(false)
      setError('Missing subscription.')
      return () => { active = false }
    }
    setLoading(true)
    void fetchProviderCopierDetails(supabase, subscriptionId)
      .then(row => {
        if (!active) return
        if (!row) {
          setDetails(null)
          setError(copy.copierDetailsNotFound ?? 'Copier details were not found.')
          return
        }
        setDetails(row)
        setError(null)
      })
      .catch(cause => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : (copy.copierDetailsError ?? 'Unable to load copier details.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [copy.copierDetailsError, copy.copierDetailsNotFound, subscriptionId])

  const close = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/social-trading/provider')
  }

  const title = copy.copierDetailsTitle ?? 'Copier details'
  const platform = details?.destinationPlatform?.trim()
  const iconSrc = platform ? platformIconSrc(platform) : null
  const accountLabel = details
    ? (details.destinationLabel?.trim()
      || details.destinationBrokerName?.trim()
      || (platform ? platform.toUpperCase() : null)
      || 'Trading account')
    : '—'

  const body = (
    <div className="relative w-full max-w-lg rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:rounded-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-green-500 dark:text-teal-300">
            {title}
          </p>
          <h1 className="mt-1 truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {details?.displayName ?? (loading ? '…' : 'Copier')}
          </h1>
          {details?.username ? (
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">@{details.username}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-lg p-2 text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
          aria-label={t.common.cancel}
          onClick={close}
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="max-h-[min(70vh,36rem)] overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-neutral-600 dark:text-neutral-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t.common.loading}
          </div>
        ) : error ? (
          <Alert variant="error">{error}</Alert>
        ) : details ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusTone(details.status)} size="sm">
                {details.status.replaceAll('_', ' ')}
              </Badge>
              {details.desiredStatus !== details.status ? (
                <Badge variant="neutral" size="sm">
                  desired {details.desiredStatus.replaceAll('_', ' ')}
                </Badge>
              ) : null}
            </div>

            <section>
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                {copy.copierDetailsAccount ?? 'Destination account'}
              </h2>
              <div className="mt-2 flex items-center gap-3 rounded-xl border border-neutral-200 px-3 py-3 dark:border-neutral-800">
                {iconSrc ? (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-xs ring-1 ring-neutral-100 dark:bg-neutral-900 dark:ring-neutral-800">
                    <img src={iconSrc} alt="" aria-hidden className="h-7 w-7 object-contain" />
                  </span>
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-[11px] font-semibold dark:bg-neutral-800">
                    {(platform ?? 'MT').slice(0, 3).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{accountLabel}</p>
                  <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {[details.destinationBrokerName, platform?.toUpperCase()].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <MoneyCard
                  label={copy.copySetup.balance}
                  value={details.destinationBalance}
                  currency={details.destinationCurrency}
                />
                <MoneyCard
                  label={copy.copySetup.equity}
                  value={details.destinationEquity}
                  currency={details.destinationCurrency}
                />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                {copy.copierDetailsRisk ?? 'Risk settings'}
              </h2>
              <dl className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
                <DetailRow
                  label={copy.copySetup.riskProfile}
                  value={mirrorSizingLabel(details.copyRisk.sizing.mode)}
                />
                <DetailRow
                  label={copy.copySetup.copyMethod}
                  value={mirrorSizingValue(details.copyRisk)}
                />
                <DetailRow
                  label={copy.copySetup.maxLot ?? 'Max lot'}
                  value={`${details.copyRisk.sizing.max_lot ?? details.maxLot} ${copy.copySetup.lots}`}
                />
                <DetailRow
                  label={copy.copySetup.copyStopLoss}
                  value={details.copyRisk.stops.copy_source_sl ? copy.copySetup.copied : copy.copySetup.notCopied}
                />
                <DetailRow
                  label={copy.copySetup.copyTakeProfit}
                  value={details.copyRisk.stops.copy_source_tp ? copy.copySetup.copied : copy.copySetup.notCopied}
                />
                <DetailRow
                  label={copy.copySetup.closeWhenTraderCloses}
                  value={details.copyRisk.stops.close_on_source_exit ? copy.copySetup.copied : copy.copySetup.notCopied}
                />
              </dl>
            </section>
          </div>
        ) : null}
      </div>

      <footer className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-between">
        <Button type="button" variant="secondary" onClick={close}>
          <ArrowLeft className="h-4 w-4" />
          {copy.back}
        </Button>
        <Button type="button" variant="secondary" onClick={() => navigate('/social-trading/provider')}>
          {copy.providerManageLink}
        </Button>
      </footer>
    </div>
  )

  return (
    <PageShell maxWidth="md">
      <PageHeader
        title={title}
        actions={(
          <Link to="/social-trading/provider" className="text-sm font-medium text-green-500 dark:text-teal-300">
            {copy.providerManageLink}
          </Link>
        )}
      />
      {createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={t.common.cancel} onClick={close} />
          <div className="relative w-full sm:flex sm:justify-center">{body}</div>
        </div>,
        document.body,
      )}
    </PageShell>
  )
}
