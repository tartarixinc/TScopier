import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useT } from '../../context/LocaleContext'
import {
  parseSymbolText,
  symbolListToText,
  type SocialCopyFilterSettings,
  type SocialCopyNewsImpact,
} from '../../lib/socialCopyFilterSettings'

const controlClass =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 sm:w-44'

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-neutral-100 py-3 last:border-0 dark:border-neutral-800 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-3">
      <div className="min-w-0">
        <p className="text-sm text-neutral-900 dark:text-neutral-50">{label}</p>
        {hint ? <p className="mt-0.5 text-xs leading-4 text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">{children}</div>
    </div>
  )
}

function OnOff({
  checked,
  onLabel,
  offLabel,
  onChange,
}: {
  checked: boolean
  onLabel: string
  offLabel: string
  onChange: (value: boolean) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
      {([
        [true, onLabel],
        [false, offLabel],
      ] as const).map(([value, label]) => (
        <button
          key={label}
          type="button"
          className={clsx(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            checked === value
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-50',
          )}
          aria-pressed={checked === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function SocialCopyFilterSettingsEditor({
  value,
  onChange,
}: {
  value: SocialCopyFilterSettings
  onChange: (next: SocialCopyFilterSettings) => void
}) {
  const t = useT()
  const cm = t.accountConfig.configureModal
  const onLabel = t.configurationsPage.on
  const offLabel = t.configurationsPage.off
  const patch = (partial: Partial<SocialCopyFilterSettings>) => onChange({ ...value, ...partial })

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800">
      <div className="border-b border-neutral-100 px-3.5 dark:border-neutral-800">
        <SettingRow label={cm.channelSymbols.tradeOnlyLabel} hint={cm.channelSymbols.tradeOnlyHint}>
          <input
            type="text"
            className={controlClass}
            value={symbolListToText(value.symbol_to_trade)}
            placeholder={cm.channelSymbols.tradeOnlyPlaceholder}
            onChange={event => patch({ symbol_to_trade: event.target.value.trim() || null })}
          />
        </SettingRow>
        <SettingRow label={cm.channelSymbols.avoidLabel} hint={cm.channelSymbols.avoidHint}>
          <input
            type="text"
            className={controlClass}
            value={symbolListToText(value.symbols_exclude)}
            placeholder={cm.channelSymbols.avoidPlaceholder}
            onChange={event => patch({ symbols_exclude: parseSymbolText(event.target.value) })}
          />
        </SettingRow>
      </div>

      <div className="px-3.5">
        <SettingRow label={cm.filters.timeFilter} hint={cm.filters.timeSubtitle}>
          <OnOff
            checked={value.time_filter_enabled}
            onLabel={onLabel}
            offLabel={offLabel}
            onChange={enabled => patch({ time_filter_enabled: enabled })}
          />
        </SettingRow>
        {value.time_filter_enabled ? (
          <SettingRow label={`${cm.filters.startTime} – ${cm.filters.endTime}`}>
            <input
              type="time"
              className={clsx(controlClass, 'sm:w-28')}
              value={value.trade_start_time || '00:00'}
              onChange={event => patch({ trade_start_time: event.target.value })}
            />
            <input
              type="time"
              className={clsx(controlClass, 'sm:w-28')}
              value={value.trade_end_time || '23:59'}
              onChange={event => patch({ trade_end_time: event.target.value })}
            />
          </SettingRow>
        ) : null}

        <SettingRow label={cm.filters.daysFilter} hint={cm.filters.daysSubtitle}>
          <OnOff
            checked={value.days_filter_enabled}
            onLabel={onLabel}
            offLabel={offLabel}
            onChange={enabled => patch({ days_filter_enabled: enabled })}
          />
        </SettingRow>
        {value.days_filter_enabled ? (
          <div className="flex flex-wrap gap-1.5 border-b border-neutral-100 py-3 dark:border-neutral-800">
            {([0, 1, 2, 3, 4, 5, 6] as const).map(day => {
              const selected = value.trade_days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-xs font-medium',
                    selected
                      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
                  )}
                  aria-pressed={selected}
                  onClick={() => {
                    const next = new Set(value.trade_days)
                    if (selected) next.delete(day)
                    else next.add(day)
                    patch({ trade_days: [...next].sort((a, b) => a - b) })
                  }}
                >
                  {cm.filters.weekdays[String(day) as keyof typeof cm.filters.weekdays].slice(0, 3)}
                </button>
              )
            })}
          </div>
        ) : null}
        {value.days_filter_enabled && value.trade_days.length === 0 ? (
          <p className="py-2 text-xs text-amber-600 dark:text-amber-400">{cm.filters.daysWarning}</p>
        ) : null}

        <SettingRow label={cm.filters.newsTrading} hint={cm.filters.newsSubtitle}>
          <OnOff
            checked={value.news_trading_enabled !== false}
            onLabel={onLabel}
            offLabel={offLabel}
            onChange={enabled => patch({
              news_trading_enabled: enabled,
              allow_high_impact_news: enabled,
            })}
          />
        </SettingRow>
        {value.news_trading_enabled === false ? (
          <>
            <div className="border-b border-neutral-100 py-3 dark:border-neutral-800">
              <p className="text-sm text-neutral-900 dark:text-neutral-50">{cm.filters.avoidImpact}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {([
                  ['high', cm.filters.impactHigh],
                  ['medium', cm.filters.impactMedium],
                  ['low', cm.filters.impactLow],
                ] as const).map(([id, label]) => {
                  const checked = value.news_avoid_impacts.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      className={clsx(
                        'rounded-md px-2.5 py-1 text-xs font-medium',
                        checked
                          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                          : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
                      )}
                      aria-pressed={checked}
                      onClick={() => {
                        const prev = value.news_avoid_impacts
                        const next = checked
                          ? prev.filter(item => item !== id)
                          : [...new Set([...prev, id])]
                        patch({ news_avoid_impacts: next as SocialCopyNewsImpact[] })
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {value.news_avoid_impacts.length === 0 ? (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{cm.filters.impactWarning}</p>
              ) : null}
            </div>
            <SettingRow label={cm.filters.closeBeforeNews}>
              <input
                type="number"
                min={0}
                className={clsx(controlClass, 'sm:w-24')}
                value={value.close_before_news_minutes}
                onChange={event => patch({ close_before_news_minutes: Math.max(0, Number(event.target.value) || 0) })}
              />
            </SettingRow>
            <SettingRow label={cm.filters.resumeAfterNews}>
              <input
                type="number"
                min={0}
                className={clsx(controlClass, 'sm:w-24')}
                value={value.resume_after_news_minutes}
                onChange={event => patch({ resume_after_news_minutes: Math.max(0, Number(event.target.value) || 0) })}
              />
            </SettingRow>
          </>
        ) : null}
      </div>
    </div>
  )
}
