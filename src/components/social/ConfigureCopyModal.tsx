import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowRight, Check, X } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { Toggle } from '../ui/Toggle'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
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
import {
  normalizeSocialCopyFilterSettings,
  updateSocialCopySubscriptionSettings,
  type MySocialCopySubscription,
} from '../../lib/socialCopy'
import type { SocialCopyFilterSettings } from '../../lib/socialCopyFilterSettings'
import { supabase } from '../../lib/supabase'
import { maskBrokerAccountIdentifier, resolveSocialAccountMode } from '../../lib/socialAccount'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useT } from '../../context/LocaleContext'
import { SocialCopyFilterSettingsEditor } from './SocialCopyFilterSettingsEditor'
import { AccountModeBadge } from './AccountModeBadge'

const MULTIPLIERS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const
const EXAMPLE_LOT = 1

function AccountLogo({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const normalized = platform.trim().toUpperCase()
  if (failed || (normalized !== 'MT4' && normalized !== 'MT5' && normalized !== 'CTRADER')) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-[11px] font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50">
        {normalized.slice(0, 3) || 'MT'}
      </span>
    )
  }
  if (normalized === 'CTRADER') {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-[9px] font-semibold tracking-wide text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50">
        CT
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
    <div className="flex items-start justify-between gap-4 text-xs">
      <dt className="text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className="max-w-[55%] text-right font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  )
}

function riskModeFromSubscription(subscription: MySocialCopySubscription): SocialCopyRiskMode {
  if (subscription.sizingMode === 'fixed_lot') return 'fixed_lot'
  if (subscription.sizingMode === 'lot_multiplier') return 'risk_multiplier'
  return 'proportional'
}

export function ConfigureCopyModal({
  trader,
  subscription,
  copy,
  onClose,
  onSaved,
}: {
  trader: SocialTrader
  subscription: MySocialCopySubscription
  copy: SocialTradingPageTranslations
  onClose: () => void
  onSaved?: () => void
}) {
  const c = copy.copySetup
  const t = useT()
  const { formatMoney } = useFormatMoney()
  const filterSectionTitle = `${t.accountConfig.configureModal.manualSubTabs.symbols} & ${t.accountConfig.configureModal.manualSubTabs.filters}`
  const { brokers } = useBrokerAccounts()
  const destination = brokers.find(broker => broker.id === subscription.destinationBrokerAccountId) ?? null

  const [riskMode, setRiskMode] = useState<SocialCopyRiskMode>(() => riskModeFromSubscription(subscription))
  const [fixedLot, setFixedLot] = useState(() => Number(subscription.fixedLot ?? 0.1) || 0.1)
  const [multiplier, setMultiplier] = useState(() => Number(subscription.lotMultiplier) || 1)
  const [maxLot, setMaxLot] = useState(() => Number(subscription.maxLot) || 0.1)
  const [advanced, setAdvanced] = useState(false)
  const [filterSettings, setFilterSettings] = useState<SocialCopyFilterSettings>(() =>
    normalizeSocialCopyFilterSettings(subscription.manualSettings),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const configurationValid = Number.isFinite(maxLot) && maxLot > 0 && maxLot <= 1000
    && (riskMode !== 'fixed_lot' || (Number.isFinite(fixedLot) && fixedLot > 0 && fixedLot <= maxLot))
    && (riskMode !== 'risk_multiplier' || (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 100))
    && (!filterSettings.days_filter_enabled || filterSettings.trade_days.length > 0)
    && (filterSettings.news_trading_enabled || filterSettings.news_avoid_impacts.length > 0)

  const traderBalance = trader.previewBalance
  const destinationBalance = destination ? resolveBrokerTotalBalance(destination) : null
  const copiedLot = estimateSocialCopyLot({
    mode: riskMode,
    traderLot: EXAMPLE_LOT,
    traderBalance,
    destinationBalance,
    fixedLot,
    multiplier,
  })
  const profileLabel = riskMode === 'fixed_lot'
    ? `${fixedLot.toFixed(2)} ${c.lots}`
    : riskMode === 'risk_multiplier'
      ? `${multiplier.toFixed(2)}x`
      : (c.proportionalProfile ?? 'Balance proportional')
  const lotLabel = riskMode === 'fixed_lot'
    ? (c.fixedCopiedLot ?? 'Fixed copied lot')
    : riskMode === 'risk_multiplier'
      ? (c.copiedLot ?? 'Copied lot')
      : (c.estimatedCopiedLot ?? 'Estimated copied lot')
  const lotValue = copiedLot == null
    ? (c.estimateUnavailable ?? 'Shown when balances are available')
    : `${Math.min(copiedLot, maxLot).toFixed(2)} ${c.lots}`
  const destinationMode = destination ? resolveSocialAccountMode(destination) : null
  const destinationLogin = destination ? resolveAccountLogin(destination) : ''

  const saveSettings = async () => {
    if (!configurationValid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const sizingMode = riskMode === 'fixed_lot' ? 'fixed_lot' : riskMode === 'risk_multiplier' ? 'lot_multiplier' : 'equity_ratio'
      await updateSocialCopySubscriptionSettings(supabase, {
        subscriptionId: subscription.id,
        sizingMode,
        fixedLot: sizingMode === 'fixed_lot' ? fixedLot : null,
        lotMultiplier: sizingMode === 'lot_multiplier' ? multiplier : 1,
        maxLot,
        manualSettings: filterSettings,
      })
      onSaved?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save copy settings.')
    } finally {
      setSubmitting(false)
    }
  }

  const title = interpolate(c.configureTitle ?? 'Configure copy · {trader}', { trader: trader.displayName })
  const saveLabel = c.saveSettings ?? 'Save settings'
  const maxLotLabel = c.maxLot ?? 'Max lot'
  const previewLabel = c.previewLabel ?? 'Preview setup'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="configure-copy-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-3xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="configure-copy-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {title}
              </h2>
              <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-green-500 dark:bg-teal-950/40 dark:text-teal-300">
                {previewLabel}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50">{c.subtitle}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-900 dark:text-neutral-50">
              <span>@{trader.username}</span>
              {destinationBalance != null ? (
                <span>
                  {c.balance}{' '}
                  <strong className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {formatMoney(destinationBalance)}
                  </strong>
                </span>
              ) : null}
              {destination ? (
                <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                  {destination.platform.toUpperCase()}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg p-2 text-neutral-900 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
            aria-label={c.close}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-4">
              {error ? <Alert variant="error">{error}</Alert> : null}

              <div className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">Advanced</p>
                  <p className="mt-0.5 text-xs leading-5 text-neutral-900 dark:text-neutral-50">
                    Show filters, symbols, and max lot.
                  </p>
                </div>
                <Toggle checked={advanced} onChange={setAdvanced} />
              </div>

              <section aria-labelledby="configure-destination-heading">
                <h3 id="configure-destination-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  {c.destinationAccount}
                </h3>
                {destination ? (
                  <div className="mt-2 flex items-center gap-3 rounded-xl border border-green-400 bg-teal-50/60 px-3 py-3 ring-1 ring-green-400 dark:bg-teal-950/20">
                    <AccountLogo platform={destination.platform} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                        {getBrokerDisplayLabel(destination)}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-900 dark:text-neutral-50">
                        {destination.broker_name?.trim() ? <span>{destination.broker_name.trim()}</span> : null}
                        <span>{destination.platform.toUpperCase()}</span>
                        {destinationLogin ? <span>{c.login} {maskBrokerAccountIdentifier(destinationLogin)}</span> : null}
                        {destinationMode ? <AccountModeBadge mode={destinationMode} /> : null}
                      </span>
                    </span>
                    <Check className="h-5 w-5 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
                  </div>
                ) : (
                  <p className="mt-2 rounded-xl border border-dashed border-neutral-300 px-3 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                    {c.noAccountsBody}
                  </p>
                )}
              </section>

              <section aria-labelledby="configure-method-heading">
                <h3 id="configure-method-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  {c.copyMethod}
                </h3>
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

                  {riskMode === 'fixed_lot' ? (
                    <label className="mt-1.5 flex items-center gap-3 text-sm text-neutral-900 dark:text-neutral-50">
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
                    <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
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
                          aria-pressed={multiplier === value}
                          onClick={() => setMultiplier(value)}
                        >
                          {value.toFixed(2)}x
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>

              {advanced ? (
                <section aria-labelledby="configure-advanced-heading" className="space-y-3 rounded-xl border border-neutral-200 px-3 py-3 dark:border-neutral-800">
                  <div className="flex items-center justify-between gap-3">
                    <h3 id="configure-advanced-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                      {filterSectionTitle}
                    </h3>
                  </div>
                  <label className="flex items-center justify-between gap-3 text-sm text-neutral-900 dark:text-neutral-50">
                    <span>{maxLotLabel}</span>
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
                  <SocialCopyFilterSettingsEditor value={filterSettings} onChange={setFilterSettings} />
                </section>
              ) : null}

              {!configurationValid ? (
                <p className="text-xs text-red-600 dark:text-red-400">
                  Enter positive sizing values. Fixed lot cannot exceed the maximum lot. Complete filter selections when enabled.
                </p>
              ) : null}
            </div>

            <section
              aria-labelledby="configure-preview-heading"
              className="self-start rounded-2xl border border-neutral-200/80 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/60 sm:p-5 lg:sticky lg:top-0 lg:max-h-[calc(94vh-9rem)] lg:overflow-y-auto"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id="configure-preview-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  {previewLabel}
                </h3>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">
                  {previewLabel}
                </span>
              </div>
              <div className="mt-4">
                <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-900 dark:text-neutral-50">
                    {c.traderAction}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <p className="truncate text-base font-semibold text-neutral-900 dark:text-neutral-50">
                      {trader.displayName}
                    </p>
                    <p className="text-xs font-semibold text-green-500 dark:text-teal-300">
                      {c.traderSize}: {EXAMPLE_LOT.toFixed(2)}
                    </p>
                  </div>
                </div>
                <div className="flex justify-center py-2 text-green-400 dark:text-green-400">
                  <ArrowDown className="h-5 w-5" aria-hidden />
                </div>
                <div className="rounded-xl border border-teal-200 bg-white p-4 dark:border-teal-900 dark:bg-neutral-950">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-green-500 dark:text-teal-300">
                    {c.yourAccount}
                  </p>
                  {destination ? (
                    <div className="mt-2 flex items-center gap-3">
                      <AccountLogo platform={destination.platform} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                          {accountRouteLabel(destination)}
                        </p>
                        {destinationLogin ? (
                          <p className="truncate text-xs text-neutral-900 dark:text-neutral-50">
                            {c.login} {maskBrokerAccountIdentifier(destinationLogin)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{c.noAccountsBody}</p>
                  )}
                  <dl className="mt-4 space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                    <PreviewValue label={lotLabel} value={lotValue} />
                    <PreviewValue label={c.copyStopLoss} value={c.copied ?? 'Copied'} />
                    <PreviewValue label={c.copyTakeProfit} value={c.copied ?? 'Copied'} />
                    <PreviewValue label={c.closeWhenTraderCloses} value={c.copied ?? 'Copied'} />
                    <PreviewValue label={c.riskProfile} value={profileLabel} />
                    {advanced ? (
                      <PreviewValue label={maxLotLabel} value={`${maxLot.toFixed(2)} ${c.lots}`} />
                    ) : null}
                  </dl>
                </div>
                {destination ? (
                  <div className="mt-3 flex items-center justify-center gap-2 text-xs font-medium text-neutral-900 dark:text-neutral-50">
                    <span className="truncate">{trader.displayName}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
                    <span className="truncate">{accountRouteLabel(destination)}</span>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:justify-end sm:px-6">
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.close}</Button>
          <Button
            type="button"
            loading={submitting}
            disabled={!configurationValid || submitting}
            onClick={() => void saveSettings()}
          >
            {saveLabel}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
