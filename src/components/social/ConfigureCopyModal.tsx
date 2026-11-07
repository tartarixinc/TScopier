import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { interpolate } from '../../i18n/interpolate'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import type { SocialCopyRiskMode } from '../../lib/socialCopyPreview'
import type { SocialTrader } from '../../lib/socialTradingFixture'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import {
  normalizeSocialCopyFilterSettings,
  updateSocialCopySubscriptionSettings,
  type MySocialCopySubscription,
} from '../../lib/socialCopy'
import type { SocialCopyFilterSettings } from '../../lib/socialCopyFilterSettings'
import { supabase } from '../../lib/supabase'
import { maskBrokerAccountIdentifier } from '../../lib/socialAccount'
import { useT } from '../../context/LocaleContext'
import { SocialCopyFilterSettingsEditor } from './SocialCopyFilterSettingsEditor'

const MULTIPLIERS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const

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
  const filterSectionTitle = `${t.accountConfig.configureModal.manualSubTabs.symbols} & ${t.accountConfig.configureModal.manualSubTabs.filters}`
  const { brokers } = useBrokerAccounts()
  const destination = brokers.find(broker => broker.id === subscription.destinationBrokerAccountId) ?? null

  const [riskMode, setRiskMode] = useState<SocialCopyRiskMode>(() => riskModeFromSubscription(subscription))
  const [fixedLot, setFixedLot] = useState(() => Number(subscription.fixedLot ?? 0.1) || 0.1)
  const [multiplier, setMultiplier] = useState(() => Number(subscription.lotMultiplier) || 1)
  const [maxLot, setMaxLot] = useState(() => Number(subscription.maxLot) || 0.1)
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="configure-copy-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-100 px-5 py-3.5 dark:border-neutral-800 sm:px-6">
          <div className="min-w-0">
            <h2 id="configure-copy-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {title}
            </h2>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="font-medium text-neutral-800 dark:text-neutral-200">@{trader.username}</span>
              {destination ? (
                <span className="mt-0.5 block truncate">
                  {c.destinationAccount}: {getBrokerDisplayLabel(destination)}
                  {resolveAccountLogin(destination)
                    ? ` · ${maskBrokerAccountIdentifier(resolveAccountLogin(destination))}`
                    : ''}
                </span>
              ) : null}
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
          <div className="space-y-8">
            <SetupSection step={1} title={c.copyMethod}>
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
                        aria-pressed={multiplier === value}
                        onClick={() => setMultiplier(value)}
                      >
                        {value.toFixed(2)}x
                      </button>
                    ))}
                  </div>
                ) : null}

                <label className="flex items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-200">
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

                {!configurationValid ? (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Enter positive sizing values. Fixed lot cannot exceed the maximum lot. Complete filter selections when enabled.
                  </p>
                ) : (
                  <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                    {riskMode === 'proportional'
                      ? c.proportionalDescription
                      : riskMode === 'fixed_lot'
                        ? c.fixedLotDescription
                        : c.riskMultiplierDescription}
                  </p>
                )}
              </div>
            </SetupSection>

            <SetupSection step={2} title={filterSectionTitle}>
              <SocialCopyFilterSettingsEditor value={filterSettings} onChange={setFilterSettings} />
            </SetupSection>
          </div>
        </div>

        {error ? <div className="px-5 pb-2 sm:px-6"><Alert variant="error">{error}</Alert></div> : null}
        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.cancel}</Button>
          <Button
            type="button"
            loading={submitting}
            disabled={!configurationValid || submitting}
            onClick={() => void saveSettings()}
          >
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4" aria-hidden />
              {saveLabel}
            </span>
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
