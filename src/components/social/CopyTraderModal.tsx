import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowRight, Check, CheckCircle2, X } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { interpolate } from '../../i18n/interpolate'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import {
  estimateSocialCopyLot,
  type SocialCopyRiskMode,
} from '../../lib/socialCopyPreview'
import type { SocialTrader } from '../../lib/socialTradingFixture'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import type { BrokerAccount } from '../../types/database'
import { changeSocialCopySubscription, createSocialCopySubscription } from '../../lib/socialCopy'
import { supabase } from '../../lib/supabase'
import { isSocialDestinationEligible, maskBrokerAccountIdentifier, resolveSocialAccountMode } from '../../lib/socialAccount'
import { AccountModeBadge } from './AccountModeBadge'

const MULTIPLIERS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const

function AccountLogo({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const normalized = platform.trim().toUpperCase()
  if (failed || (normalized !== 'MT4' && normalized !== 'MT5')) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-[11px] font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50">
        {normalized || 'MT'}
      </span>
    )
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-xs ring-1 ring-neutral-100 dark:bg-neutral-900 dark:ring-neutral-800">
      <img
        src={`/${normalized}.png`}
        alt=""
        aria-hidden
        className="h-7 w-7 object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
function accountRouteLabel(account: BrokerAccount): string {
  const broker = account.broker_name?.trim() || getBrokerDisplayLabel(account)
  return `${broker} ${account.platform.toUpperCase()}`
}

function PreviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <dt className="text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className="text-right font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  )
}

export function CopyTraderModal({
  trader,
  copy,
  onClose,
  onConnectBroker,
}: {
  trader: SocialTrader
  copy: SocialTradingPageTranslations
  onClose: () => void
  onConnectBroker: () => void
}) {
  const c = copy.copySetup
  const { brokers, loading } = useBrokerAccounts()
  const { formatMoney } = useFormatMoney()
  const [selectedBrokerId, setSelectedBrokerId] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [riskMode, setRiskMode] = useState<SocialCopyRiskMode>(() => trader.syntheticDemo ? 'fixed_lot' : 'proportional')
  const [fixedLot, setFixedLot] = useState(0.1)
  const [multiplier, setMultiplier] = useState(0.75)
  const [maxLot, setMaxLot] = useState(0.1)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [subscriptionState, setSubscriptionState] = useState<'pending' | 'pause_requested' | 'stop_requested'>('pending')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const destinations = brokers.filter(isSocialDestinationEligible)
  const sources = trader.sources?.length ? trader.sources : trader.sourceId ? [{
    sourceId: trader.sourceId,
    label: trader.sourceLabel ?? 'Copy source',
    provider: trader.sourceProvider ?? 'fxsocket',
    platform: trader.sourcePlatform ?? 'MT5',
    accountHint: 'Identifier unavailable',
    accountMode: trader.sourceAccountMode ?? 'unknown',
    connectionHealthy: true,
    isCopyEligible: trader.copyEligible === true,
    eligibilityReason: trader.copyEligibilityReason ?? 'source_missing',
    isSynthetic: trader.syntheticDemo === true,
  }] : []
  const selectedBroker = destinations.find(broker => broker.id === selectedBrokerId) ?? null
  const selectedSource = sources.find(source => source.sourceId === selectedSourceId) ?? null
  const selectedSourceUsesLoadedPerformance = selectedSource?.sourceId === trader.sourceId
  const previewTrade = selectedSourceUsesLoadedPerformance ? trader.openTrades[0] ?? null : null
  const isSyntheticSimulation = selectedSource?.isSynthetic === true
  const destinationMode = selectedBroker ? resolveSocialAccountMode(selectedBroker) : 'unknown'
  const destinationBalance = selectedBroker ? resolveBrokerTotalBalance(selectedBroker) : null
  const copiedLot = previewTrade?.previewLot != null && trader.previewBalance != null
    ? estimateSocialCopyLot({
        mode: riskMode,
        traderLot: previewTrade.previewLot,
        traderBalance: trader.previewBalance,
        destinationBalance,
        fixedLot,
        multiplier,
      })
    : riskMode === 'fixed_lot' ? fixedLot : null

  const profileLabel = riskMode === 'fixed_lot'
    ? `${fixedLot.toFixed(2)} ${c.lots}`
    : riskMode === 'risk_multiplier'
      ? `${multiplier.toFixed(2)}x`
      : c.proportionalProfile

  const copiedLotLabel = riskMode === 'fixed_lot'
    ? c.fixedCopiedLot
    : riskMode === 'proportional'
      ? c.estimatedCopiedLot
      : c.copiedLot

  const accountBalanceLabel = selectedBroker ? formatMoney(resolveBrokerTotalBalance(selectedBroker)) : null
  const configurationValid = Number.isFinite(maxLot) && maxLot > 0 && maxLot <= 1000
    && (riskMode !== 'fixed_lot' || (Number.isFinite(fixedLot) && fixedLot > 0 && fixedLot <= maxLot))
    && (riskMode !== 'risk_multiplier' || (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 100))

  const submitCopy = async () => {
    if (!selectedBroker || !selectedSource?.isCopyEligible || destinationMode === 'unknown' || !configurationValid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const sizingMode = riskMode === 'fixed_lot' ? 'fixed_lot' : riskMode === 'risk_multiplier' ? 'lot_multiplier' : 'equity_ratio'
      const createdSubscriptionId = await createSocialCopySubscription(supabase, {
        sourceId: selectedSource.sourceId,
        destinationBrokerAccountId: selectedBroker.id,
        sizingMode,
        fixedLot: sizingMode === 'fixed_lot' ? fixedLot : null,
        lotMultiplier: sizingMode === 'lot_multiplier' ? multiplier : 1,
        maxLot,
        accountMode: destinationMode,
      })
      setSubscriptionId(createdSubscriptionId)
      setSubscriptionState('pending')
      setReady(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create the copy subscription.')
    } finally {
      setSubmitting(false)
    }
  }

  const requestSubscriptionChange = async (action: 'pause' | 'stop') => {
    if (!subscriptionId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await changeSocialCopySubscription(supabase, subscriptionId, action)
      setSubscriptionState(action === 'pause' ? 'pause_requested' : 'stop_requested')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update the copy subscription.')
    } finally {
      setSubmitting(false)
    }
  }
  const disabled = !selectedBroker || !selectedSource?.isCopyEligible || destinationMode === 'unknown' || !configurationValid || submitting

  if (ready && selectedBroker) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-trader-success-title"
      >
        <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
        <div className="relative w-full rounded-t-2xl border border-neutral-200/65 bg-white px-6 py-8 text-center shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-md sm:rounded-2xl">
          <button
            type="button"
            className="absolute right-4 top-4 rounded-lg p-2 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={c.close}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-green-400 dark:bg-teal-950/40 dark:text-teal-300">
            <CheckCircle2 className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-green-500 dark:text-teal-300">{isSyntheticSimulation ? 'SIMULATED DEMO \u2014 NO BROKER ORDERS' : c.previewLabel}</p>
          <h2 id="copy-trader-success-title" className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-50">{isSyntheticSimulation ? c.successTitle : 'Subscription request created'}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-neutral-900 dark:text-neutral-50">
            {`Your request to copy ${trader.displayName} is persisted and pending worker acknowledgement. No active status is claimed until the worker confirms it.`}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-900 ring-1 ring-neutral-200/70 dark:bg-neutral-900 dark:text-neutral-100 dark:ring-neutral-800">
            <span>{trader.displayName}</span>
            <ArrowRight className="h-4 w-4 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
            <span>{accountRouteLabel(selectedBroker)}</span>
          </div>
          {isSyntheticSimulation ? <Alert variant="warning">Synthetic simulation only. The worker will acknowledge the persisted lifecycle state without creating broker orders or contacting a broker.</Alert> : null}
          {(
            <div className="mt-4 space-y-3 text-left">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <strong>Status:</strong> {subscriptionState === 'pending' ? 'Pending worker acknowledgement' : subscriptionState === 'pause_requested' ? 'Pause requested' : 'Stop requested'}
                {subscriptionId ? <span className="mt-1 block break-all text-[10px] opacity-75">Subscription {subscriptionId}</span> : null}
              </div>
              <p className="text-xs leading-5 text-neutral-600 dark:text-neutral-300">Sizing: {profileLabel}; maximum lot {maxLot.toFixed(2)}. Broker execution can differ because of market conditions and account constraints.</p>
              {error ? <Alert variant="error">{error}</Alert> : null}
              {subscriptionState !== 'stop_requested' ? (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" disabled={submitting || subscriptionState === 'pause_requested'} onClick={() => void requestSubscriptionChange('pause')}>Request pause</Button>
                  <Button type="button" size="sm" variant="secondary" disabled={submitting} onClick={() => void requestSubscriptionChange('stop')}>Stop copying</Button>
                </div>
              ) : null}
            </div>
          )}
          <Button type="button" className="mt-6 w-full" disabled={submitting} onClick={onClose}>{c.done}</Button>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="copy-trader-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-3xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="copy-trader-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {interpolate(c.title, { trader: trader.displayName })}
              </h2>
              <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-green-500 dark:bg-teal-950/40 dark:text-teal-300">
                {isSyntheticSimulation ? 'SIMULATED DEMO \u2014 NO BROKER ORDERS' : c.previewLabel}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50">{c.subtitle}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-900 dark:text-neutral-50">
              <span>@{trader.username}</span>
              <span>{copy.roi} <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{trader.roi == null ? 'Unavailable' : trader.roi.toFixed(1) + '%'}</strong></span>
              <span>{copy.maxDrawdown} <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{trader.maxDrawdown == null ? 'Unavailable' : trader.maxDrawdown.toFixed(1) + '%'}</strong></span>
              <span>{copy.winRate} <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{trader.winRate == null ? 'Unavailable' : trader.winRate.toFixed(1) + '%'}</strong></span>
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg p-2 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={c.close}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-4">
              <section aria-labelledby="copy-source-heading">
                <h3 id="copy-source-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Provider source account</h3>
                <select
                  value={selectedSourceId}
                  onChange={event => setSelectedSourceId(event.target.value)}
                  className="mt-2 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                >
                  <option value="" disabled>Select an eligible source account</option>
                  {sources.map(source => (
                    <option key={source.sourceId} value={source.sourceId} disabled={!source.isCopyEligible}>
                      {source.label} / {source.platform} / {source.accountHint} / {source.accountMode.toUpperCase()} / {source.isCopyEligible ? 'Eligible' : 'Unavailable'}
                    </option>
                  ))}
                </select>
                {!selectedSource ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Select an eligible provider source. No account is selected automatically.</p> : (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                    <AccountModeBadge mode={selectedSource.accountMode} />
                    <span>{selectedSource.label}</span>
                    <span>{selectedSource.accountHint}</span>
                  </div>
                )}
              </section>

              <section aria-labelledby="copy-destination-heading">
                <h3 id="copy-destination-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{c.destinationAccount}</h3>
                {loading ? (
                  <p className="mt-3 text-sm text-neutral-900 dark:text-neutral-50">{c.loadingAccounts}</p>
                ) : destinations.length === 0 ? (
                  <div className="mt-2 rounded-xl border border-dashed border-neutral-300 px-4 py-3 dark:border-neutral-700">
                    <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{c.noAccountsTitle}</p>
                    <p className="mt-1 text-xs leading-5 text-neutral-900 dark:text-neutral-50">{c.noAccountsBody}</p>
                    <Button type="button" size="sm" className="mt-3" onClick={onConnectBroker}>{c.connectBroker}</Button>
                  </div>
                ) : (
                  <div className="mt-2 max-h-52 space-y-2 overflow-y-auto pr-1">
                    {destinations.map(broker => {
                      const login = resolveAccountLogin(broker)
                      return (
                        <button
                          key={broker.id}
                          type="button"
                          className={clsx(
                            'flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-start transition-colors',
                            broker.id === selectedBrokerId
                              ? 'border-green-400 bg-teal-50/60 ring-1 ring-green-400 dark:bg-teal-950/20'
                              : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-900',
                          )}
                          aria-pressed={broker.id === selectedBrokerId}
                          onClick={() => setSelectedBrokerId(broker.id)}
                        >
                          <AccountLogo platform={broker.platform} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{getBrokerDisplayLabel(broker)}</span>
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-900 dark:text-neutral-50">
                              {broker.broker_name?.trim() ? <span>{broker.broker_name.trim()}</span> : null}
                              <span>{broker.platform.toUpperCase()}</span>
                              {login ? <span>{c.login} {login}</span> : null}
                            </span>
                          </span>
                          {broker.id === selectedBrokerId ? <Check className="h-5 w-5 shrink-0 text-green-400 dark:text-green-400" aria-hidden /> : null}
                        </button>
                      )
                    })}
                  </div>
                )}
                {selectedBroker && (selectedBroker.last_balance != null || selectedBroker.last_equity != null) ? (
                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-neutral-900 dark:text-neutral-50">
                    {selectedBroker.last_balance != null ? <div><dt className="inline">{c.balance}: </dt><dd className="inline font-medium text-neutral-900 dark:text-neutral-50">{accountBalanceLabel}</dd></div> : null}
                    {selectedBroker.last_equity != null ? <div><dt className="inline">{c.equity}: </dt><dd className="inline font-medium text-neutral-900 dark:text-neutral-50">{formatMoney(selectedBroker.last_equity)}</dd></div> : null}
                  </dl>
                ) : null}
              </section>

              <section aria-labelledby="copy-method-heading">
                <h3 id="copy-method-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{c.copyMethod}</h3>
                <div className="mt-2 grid gap-1.5">
                  {([
                    ['proportional', c.proportional, c.proportionalDescription],
                    ['fixed_lot', c.fixedLot, c.fixedLotDescription],
                    ['risk_multiplier', c.riskMultiplier, c.riskMultiplierDescription],
                  ] as const).map(([mode, label, description]) => (
                    <button
                      key={mode}
                      type="button"
                      className={clsx(
                        'rounded-xl border px-3 py-2 text-start transition-colors',
                        riskMode === mode
                          ? 'border-green-400 bg-teal-50/60 ring-1 ring-green-400 dark:bg-teal-950/20'
                          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700',
                      )}
                      aria-pressed={riskMode === mode}
                      onClick={() => setRiskMode(mode)}
                    >
                      <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">{label}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-neutral-900 dark:text-neutral-50">{description}</span>
                    </button>
                  ))}
                </div>
                {riskMode === 'fixed_lot' ? (
                  <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{c.fixedLot}</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={fixedLot}
                      onChange={event => setFixedLot(Number(event.target.value))}
                      className="w-24 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tabular-nums text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                    />
                    <span className="text-xs text-neutral-900 dark:text-neutral-50">{c.lots}</span>
                  </label>
                ) : null}
                {riskMode === 'risk_multiplier' ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {MULTIPLIERS.map(value => (
                      <button
                        key={value}
                        type="button"
                        className={clsx(
                          'rounded-lg border px-2 py-2 text-xs font-semibold tabular-nums',
                          multiplier === value
                            ? 'border-green-400 bg-teal-50 text-green-500 dark:bg-teal-950/30 dark:text-teal-300'
                            : 'border-neutral-200 text-neutral-900 dark:border-neutral-800 dark:text-neutral-50',
                        )}
                        onClick={() => setMultiplier(value)}
                      >
                        {value.toFixed(2)}x
                      </button>
                    ))}
                  </div>
                ) : null}
                <label className="mt-3 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                  <span>Maximum lot</span>
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={maxLot}
                    onChange={event => setMaxLot(Number(event.target.value))}
                    className="w-24 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tabular-nums text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                  />
                  <span className="text-xs text-neutral-900 dark:text-neutral-50">{c.lots}</span>
                </label>
                {!configurationValid ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">Enter positive sizing values. Fixed lot cannot exceed the maximum lot.</p> : null}
              </section>

              <Alert variant="warning">Only the sizing mode and maximum-lot cap shown here are saved by social copying. Broker execution, slippage, symbol availability, margin, and account risk limits can change or reject a copied order.</Alert>
            </div>

            <section aria-labelledby="copy-preview-heading" className="self-start rounded-2xl border border-neutral-200/80 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/60 sm:p-5 lg:sticky lg:top-0">
              <div className="flex items-center justify-between gap-3">
                <h3 id="copy-preview-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{c.setupPreview}</h3>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">{isSyntheticSimulation ? 'SIMULATED DEMO \u2014 NO BROKER ORDERS' : c.previewLabel}</span>
              </div>
              {previewTrade ? (
                <div className="mt-4">
                  <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-900 dark:text-neutral-50">{c.traderAction}</p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <p className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">
                        <span>{previewTrade.symbol}</span>
                        <span className={clsx('text-xs font-semibold', previewTrade.side === 'buy' ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
                          {previewTrade.side.toUpperCase()}
                        </span>
                      </p>
                      <p className={clsx('text-xs font-semibold', previewTrade.side === 'buy' ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>{c.traderSize}: {previewTrade.previewLot == null ? 'Unavailable' : previewTrade.previewLot.toFixed(2)}</p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-900 dark:text-neutral-50">
                      <span>{c.stopLoss} {previewTrade.previewStopLoss ?? 'N/A'}</span>
                      <span>{c.takeProfit} {previewTrade.previewTakeProfit ?? 'N/A'}</span>
                    </div>
                  </div>
                  <div className="flex justify-center py-2 text-green-400 dark:text-green-400"><ArrowDown className="h-5 w-5" aria-hidden /></div>
                  <div className="rounded-xl border border-teal-200 bg-white p-4 dark:border-teal-900 dark:bg-neutral-950">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">{c.yourAccount}</p>
                    {selectedBroker ? (
                      <>
                        <div className="mt-2 flex items-center gap-3">
                          <AccountLogo platform={selectedBroker.platform} />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{accountRouteLabel(selectedBroker)}</p>
                            <div className="mt-1 flex items-center gap-2"><AccountModeBadge mode={destinationMode} /><p className="truncate text-xs text-neutral-900 dark:text-neutral-50">{maskBrokerAccountIdentifier(resolveAccountLogin(selectedBroker))}</p></div>
                          </div>
                        </div>
                        <dl className="mt-4 space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                          <PreviewValue label={copiedLotLabel} value={copiedLot == null ? 'Calculated by the worker when a trade arrives' : `${copiedLot.toFixed(2)} ${c.lots}`} />
                          <PreviewValue label="Maximum lot" value={`${maxLot.toFixed(2)} ${c.lots}`} />
                          <PreviewValue label={c.riskProfile} value={profileLabel} />
                        </dl>
                      </>
                    ) : (
                      <p className="mt-3 text-sm text-neutral-900 dark:text-neutral-50">{c.noAccountsBody}</p>
                    )}
                  </div>
                  {selectedBroker ? (
                    <div className="mt-3 flex items-center justify-center gap-2 text-xs font-medium text-neutral-900 dark:text-neutral-50">
                      <span className="truncate">{trader.displayName}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
                      <span className="truncate">{accountRouteLabel(selectedBroker)}</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-neutral-900 dark:text-neutral-50">{c.noOpenTrade}</p>
              )}
            </section>
          </div>
        </div>

        {error ? <div className="px-5 pb-3 sm:px-6"><Alert variant="error">{error}</Alert></div> : null}
        {selectedBroker ? (
          <div className="border-t border-neutral-100 bg-neutral-50 px-5 py-3 text-xs leading-5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200 sm:px-6" aria-label="Copy confirmation summary">
            {isSyntheticSimulation ? 'Simulated only: ' : 'Subscription request: '}
            <strong>{selectedSource?.label ?? 'No source selected'}</strong> ({selectedSource?.accountMode ?? 'unknown'}) to <strong>{accountRouteLabel(selectedBroker)}</strong> ({destinationMode}), {profileLabel}, maximum lot {maxLot.toFixed(2)}.
          </div>
        ) : null}
        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:justify-end sm:px-6">
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.cancel}</Button>
          <Button
            type="button"
            loading={submitting}
            disabled={disabled}
            onClick={() => void submitCopy()}
          >
            {isSyntheticSimulation ? 'Create simulated subscription' : c.startCopying}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
