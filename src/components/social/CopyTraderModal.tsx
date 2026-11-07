import { useEffect, useState, type ReactNode } from 'react'
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
import { changeSocialCopySubscription, createSocialCopySubscription, subscribeSocialCopyIntent } from '../../lib/socialCopy'
import {
  DEFAULT_SOCIAL_COPY_FILTER_SETTINGS,
  type SocialCopyFilterSettings,
} from '../../lib/socialCopyFilterSettings'
import { supabase } from '../../lib/supabase'
import { isSocialDestinationEligible, maskBrokerAccountIdentifier, resolveSocialAccountMode } from '../../lib/socialAccount'
import { sourceAllowsCopy } from '../../lib/socialCopyAvailability'
import { eligibilityDiagnosticForReason } from '../../lib/socialEligibility'
import { useT } from '../../context/LocaleContext'
import { AccountModeBadge } from './AccountModeBadge'
import { SocialCopyFilterSettingsEditor } from './SocialCopyFilterSettingsEditor'
const MULTIPLIERS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const

function isPaidCopyPrice(cents: number | null | undefined): boolean {
  return cents != null && cents > 0
}

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

function SetupSection({
  step,
  title,
  children,
}: {
  step: number
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold tabular-nums text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {step}
        </span>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h3>
      </div>
      <div className="sm:pl-8">{children}</div>
    </section>
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
  const t = useT()
  const filterSectionTitle = `${t.accountConfig.configureModal.manualSubTabs.symbols} & ${t.accountConfig.configureModal.manualSubTabs.filters}`
  const { brokers, loading } = useBrokerAccounts()
  const { formatMoney } = useFormatMoney()
  const [selectedBrokerId, setSelectedBrokerId] = useState('')
  const [riskMode, setRiskMode] = useState<SocialCopyRiskMode>(() => trader.syntheticDemo ? 'fixed_lot' : 'proportional')
  const [fixedLot, setFixedLot] = useState(0.1)
  const [multiplier, setMultiplier] = useState(0.75)
  const [maxLot, setMaxLot] = useState(0.1)
  const [filterSettings, setFilterSettings] = useState<SocialCopyFilterSettings>(DEFAULT_SOCIAL_COPY_FILTER_SETTINGS)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [subscriptionState, setSubscriptionState] = useState<'pending' | 'pause_requested' | 'stop_requested'>('pending')
  const pricePaid = isPaidCopyPrice(trader.monthlyCopyPriceCents)
  const [paywallCleared, setPaywallCleared] = useState(!pricePaid)
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
  useEffect(() => {
    if (selectedBrokerId || destinations.length !== 1) return
    setSelectedBrokerId(destinations[0].id)
  }, [destinations, selectedBrokerId])
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
    eligibilityDiagnostics: [eligibilityDiagnosticForReason(trader.copyEligibilityReason ?? 'source_missing')],
    isSynthetic: trader.syntheticDemo === true,
  }] : []
  const selectedBroker = destinations.find(broker => broker.id === selectedBrokerId) ?? null
  // Always use the provider's registered copy account — no source picker in this modal.
  const selectedSource = (
    sources.find(source => sourceAllowsCopy(source) && source.sourceId === trader.sourceId)
    ?? sources.find(source => sourceAllowsCopy(source))
    ?? null
  )
  const previewTrade = selectedSource?.sourceId === trader.sourceId ? trader.openTrades[0] ?? null : null
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

  const configurationValid = Number.isFinite(maxLot) && maxLot > 0 && maxLot <= 1000
    && (riskMode !== 'fixed_lot' || (Number.isFinite(fixedLot) && fixedLot > 0 && fixedLot <= maxLot))
    && (riskMode !== 'risk_multiplier' || (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 100))
    && (!filterSettings.days_filter_enabled || filterSettings.trade_days.length > 0)
    && (filterSettings.news_trading_enabled || filterSettings.news_avoid_impacts.length > 0)

  const submitCopy = async () => {
    if (!selectedBroker || !selectedSource || !sourceAllowsCopy(selectedSource) || destinationMode === 'unknown' || !configurationValid || submitting) return
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
        manualSettings: filterSettings,
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

  const confirmPaywallSubscribe = async () => {
    if (!pricePaid || paywallCleared || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await subscribeSocialCopyIntent(supabase, trader.id)
      setPaywallCleared(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record the subscription intent.')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = !selectedBroker || !selectedSource || !sourceAllowsCopy(selectedSource) || destinationMode === 'unknown' || !configurationValid || submitting
  const showPaywall = pricePaid && !paywallCleared
  const priceLabel = pricePaid && trader.monthlyCopyPriceCents != null
    ? formatMoney(trader.monthlyCopyPriceCents / 100)
    : ''

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
      <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800 sm:px-6">
          <div className="min-w-0">
            <h2 id="copy-trader-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {showPaywall
                ? interpolate(c.paywallTitle, { trader: trader.displayName })
                : interpolate(c.title, { trader: trader.displayName })}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="font-medium text-neutral-800 dark:text-neutral-200">@{trader.username}</span>
              {isSyntheticSimulation ? <span className="text-amber-600 dark:text-amber-400">Simulated demo</span> : null}
              <span>{copy.roi} {trader.roi == null ? '—' : `${trader.roi.toFixed(1)}%`}</span>
              <span>{copy.winRate} {trader.winRate == null ? '—' : `${trader.winRate.toFixed(1)}%`}</span>
              {pricePaid && trader.monthlyCopyPriceCents != null
                ? <span className="font-medium text-neutral-800 dark:text-neutral-200">{formatMoney(trader.monthlyCopyPriceCents / 100)}/mo</span>
                : <span>{copy.priceFree}</span>}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
            aria-label={c.close}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          {showPaywall ? (
            <section aria-labelledby="copy-paywall-heading" className="mx-auto max-w-md space-y-4 py-4 text-center sm:py-8">
              <p className="text-3xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
                {priceLabel}<span className="text-base font-medium text-neutral-500 dark:text-neutral-400">/Month</span>
              </p>
              <p id="copy-paywall-heading" className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                {c.paywallBody}
              </p>
              <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">{c.paywallPendingNote}</p>
              {error ? <Alert variant="error">{error}</Alert> : null}
            </section>
          ) : (
          <div className="space-y-8">
            <SetupSection step={1} title={c.destinationAccount}>
              {loading ? (
                <p className="text-sm text-neutral-600 dark:text-neutral-300">{c.loadingAccounts}</p>
              ) : destinations.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-300 px-3 py-3 dark:border-neutral-700">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{c.noAccountsTitle}</p>
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">{c.noAccountsBody}</p>
                  <Button type="button" size="sm" className="mt-3" onClick={onConnectBroker}>{c.connectBroker}</Button>
                </div>
              ) : (
                <div className="max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
                  {destinations.map(broker => {
                    const login = resolveAccountLogin(broker)
                    const selected = broker.id === selectedBrokerId
                    return (
                      <button
                        key={broker.id}
                        type="button"
                        className={clsx(
                          'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-colors',
                          selected
                            ? 'border-green-400 bg-emerald-50/70 ring-1 ring-green-400 dark:bg-emerald-950/20'
                            : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-900',
                        )}
                        aria-pressed={selected}
                        onClick={() => setSelectedBrokerId(broker.id)}
                      >
                        <AccountLogo platform={broker.platform} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{getBrokerDisplayLabel(broker)}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-600 dark:text-neutral-300">
                            <span>{broker.platform.toUpperCase()}</span>
                            {login ? <span>{maskBrokerAccountIdentifier(login)}</span> : null}
                            {broker.last_balance != null ? <span>{formatMoney(resolveBrokerTotalBalance(broker))}</span> : null}
                          </span>
                        </span>
                        {selected ? <Check className="h-4 w-4 shrink-0 text-green-500" aria-hidden /> : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </SetupSection>

            <SetupSection step={2} title={c.copyMethod}>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-1.5">
                  {([
                    ['proportional', c.proportional],
                    ['fixed_lot', c.fixedLot],
                    ['risk_multiplier', c.riskMultiplier],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={clsx(
                        'rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                        riskMode === mode
                          ? 'border-green-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                          : 'border-neutral-200 text-neutral-700 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-200',
                      )}
                      aria-pressed={riskMode === mode}
                      onClick={() => setRiskMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {riskMode === 'fixed_lot' ? (
                  <label className="flex items-center justify-between gap-3 text-sm text-neutral-700 dark:text-neutral-200">
                    <span>{c.fixedLot}</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={fixedLot}
                        onChange={event => setFixedLot(Number(event.target.value))}
                        className="w-24 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tabular-nums text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                      />
                      <span className="text-xs text-neutral-500">{c.lots}</span>
                    </span>
                  </label>
                ) : null}

                {riskMode === 'risk_multiplier' ? (
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                    {MULTIPLIERS.map(value => (
                      <button
                        key={value}
                        type="button"
                        className={clsx(
                          'rounded-lg border px-2 py-1.5 text-xs font-semibold tabular-nums',
                          multiplier === value
                            ? 'border-green-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                            : 'border-neutral-200 text-neutral-700 dark:border-neutral-800 dark:text-neutral-200',
                        )}
                        onClick={() => setMultiplier(value)}
                      >
                        {value.toFixed(2)}x
                      </button>
                    ))}
                  </div>
                ) : null}

                <label className="flex items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-200">
                  <span>Max lot</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0.01"
                      max="1000"
                      step="0.01"
                      value={maxLot}
                      onChange={event => setMaxLot(Number(event.target.value))}
                      className="w-24 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tabular-nums text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                    />
                    <span className="text-xs text-neutral-500">{c.lots}</span>
                  </span>
                </label>

                {!configurationValid ? (
                  <p className="text-xs text-red-600 dark:text-red-400">Enter positive sizing values. Fixed lot cannot exceed the maximum lot. Complete filter selections when enabled.</p>
                ) : (
                  <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                    {riskMode === 'proportional' ? c.proportionalDescription : riskMode === 'fixed_lot' ? c.fixedLotDescription : c.riskMultiplierDescription}
                  </p>
                )}
              </div>
            </SetupSection>

            <SetupSection step={3} title={filterSectionTitle}>
              <SocialCopyFilterSettingsEditor value={filterSettings} onChange={setFilterSettings} />
            </SetupSection>

            <SetupSection step={4} title={c.setupPreview}>
              {previewTrade ? (
                <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
                  <div className="flex items-center justify-between gap-3 bg-neutral-50 px-3.5 py-3 dark:bg-neutral-900/70">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">{c.traderAction}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                        <span>{previewTrade.symbol}</span>
                        <span className={clsx('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', previewTrade.side === 'buy' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300')}>
                          {previewTrade.side.toUpperCase()}
                        </span>
                        <span className="font-normal tabular-nums text-neutral-600 dark:text-neutral-300">
                          {previewTrade.previewLot == null ? '—' : `${previewTrade.previewLot.toFixed(2)} ${c.lots}`}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {c.stopLoss} {previewTrade.previewStopLoss ?? '—'} · {c.takeProfit} {previewTrade.previewTakeProfit ?? '—'}
                      </p>
                    </div>
                    <ArrowDown className="h-4 w-4 shrink-0 text-green-500" aria-hidden />
                  </div>
                  <div className="px-3.5 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-green-600 dark:text-teal-300">{c.yourAccount}</p>
                    {selectedBroker ? (
                      <div className="mt-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{accountRouteLabel(selectedBroker)}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <AccountModeBadge mode={destinationMode} />
                            <p className="truncate text-xs text-neutral-600 dark:text-neutral-300">{maskBrokerAccountIdentifier(resolveAccountLogin(selectedBroker))}</p>
                          </div>
                        </div>
                        <dl className="shrink-0 text-right">
                          <div>
                            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">{copiedLotLabel}</dt>
                            <dd className="text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
                              {copiedLot == null ? '—' : copiedLot.toFixed(2)}
                            </dd>
                          </div>
                          <div className="mt-1">
                            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">{c.riskProfile}</dt>
                            <dd className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{profileLabel} · max {maxLot.toFixed(2)}</dd>
                          </div>
                        </dl>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{c.noAccountsBody}</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-5 text-center text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  {c.noOpenTrade}
                </div>
              )}
            </SetupSection>
          </div>
          )}
        </div>

        {!showPaywall && error ? <div className="px-5 pb-2 sm:px-6"><Alert variant="error">{error}</Alert></div> : null}
        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {showPaywall ? (
            <>
              <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">{c.paywallPendingNote}</p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.cancel}</Button>
                <Button type="button" loading={submitting} disabled={submitting} onClick={() => void confirmPaywallSubscribe()}>
                  {interpolate(c.paywallSubscribe, { amount: priceLabel })}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                {selectedBroker
                  ? `${trader.displayName} → ${accountRouteLabel(selectedBroker)} · ${profileLabel} · max ${maxLot.toFixed(2)} ${c.lots}`
                  : c.noAccountsBody}
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.cancel}</Button>
                <Button type="button" loading={submitting} disabled={disabled} onClick={() => void submitCopy()}>
                  {isSyntheticSimulation ? 'Create simulated subscription' : c.startCopying}
                </Button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
