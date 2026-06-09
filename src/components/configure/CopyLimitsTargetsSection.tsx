import { useMemo } from 'react'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { Select } from '../ui/Select'
import { ConfigTitle, ConfigToggleLabel, ConfigureInput, ConfigureSelect } from '../ui/InfoTooltip'
import { interpolate } from '../../i18n/interpolate'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import {
  DEFAULT_COPY_LIMITS,
  normalizeCopyLimits,
  type CopyLimitPeriod,
  type CopyLimitsConfig,
  type CopyLimitState,
  type CopyLimitValueType,
  type MaxRiskRule,
  type ProfitTargetRule,
} from '../../lib/copyLimitTypes'
import { isChannelCopyLimitPaused, resolveCopyLimitTimezone } from '../../lib/copyLimitEvaluate'
import { buildTimezoneOptions } from '../../lib/timezoneOptions'

type StopsCopy = ConfigureModalTranslations['stops']

const PERIOD_OPTIONS: Array<{ value: CopyLimitPeriod; labelKey: keyof StopsCopy }> = [
  { value: 'daily', labelKey: 'periodDaily' },
  { value: 'weekly', labelKey: 'periodWeekly' },
  { value: 'monthly', labelKey: 'periodMonthly' },
  { value: 'overall', labelKey: 'periodOverall' },
]

function newTargetId(): string {
  return `pt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function newRiskId(): string {
  return `mr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function CopyLimitsTargetsSection(props: {
  copyLimits: CopyLimitsConfig | undefined
  copyLimitState: CopyLimitState | undefined
  profileTimezone: string
  labels: StopsCopy
  onChange: (next: CopyLimitsConfig) => void
}) {
  const limits = normalizeCopyLimits(props.copyLimits ?? DEFAULT_COPY_LIMITS)
  const state = props.copyLimitState ?? { paused_period_keys: [], periods: {} }
  const tz = resolveCopyLimitTimezone(limits, props.profileTimezone)
  const timezoneOptions = useMemo(() => buildTimezoneOptions(), [])

  const pause = isChannelCopyLimitPaused({ config: limits, state, timeZone: tz })
  const pauseBanner = pause?.reason === 'channel_max_risk_hit'
    ? props.labels.pausedRiskBanner
    : pause?.pauseKey?.includes('overall')
      ? props.labels.pausedOverallBanner
      : pause
        ? props.labels.pausedProfitBanner
        : null

  const needsTimezone = limits.profit_targets_enabled || limits.max_risk_enabled

  const patchLimits = (patch: Partial<CopyLimitsConfig>) => {
    props.onChange(normalizeCopyLimits({ ...limits, ...patch }))
  }

  const periodSelectOptions = PERIOD_OPTIONS.map(o => ({
    value: o.value,
    label: props.labels[o.labelKey] as string,
  }))

  const valueTypeOptions = [
    { value: 'amount', label: props.labels.valueTypeAmount },
    { value: 'percent', label: props.labels.valueTypePercent },
  ]

  const updateTarget = (idx: number, patch: Partial<ProfitTargetRule>) => {
    const next = limits.profit_targets.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    patchLimits({ profit_targets: next })
  }

  const updateRisk = (idx: number, patch: Partial<MaxRiskRule>) => {
    const next = limits.max_risks.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    patchLimits({ max_risks: next })
  }

  return (
    <div className="space-y-6">
      {pauseBanner ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {pauseBanner}
        </div>
      ) : null}

      {needsTimezone ? (
        <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
          <ConfigTitle info={props.labels.timezoneHint}>{props.labels.timezoneTitle}</ConfigTitle>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="copy-limit-tz-mode"
                checked={limits.timezone_mode === 'profile'}
                onChange={() => patchLimits({ timezone_mode: 'profile' })}
              />
              {interpolate(props.labels.timezoneProfile, { tz: props.profileTimezone })}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="copy-limit-tz-mode"
                checked={limits.timezone_mode === 'custom'}
                onChange={() => patchLimits({
                  timezone_mode: 'custom',
                  timezone: limits.timezone ?? props.profileTimezone,
                })}
              />
              {props.labels.timezoneCustom}
            </label>
          </div>
          {limits.timezone_mode === 'custom' ? (
            <Select
              value={limits.timezone ?? props.profileTimezone}
              onChange={e => patchLimits({ timezone: e.target.value })}
              options={timezoneOptions}
            />
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <ConfigTitle info={props.labels.profitTargetsIntro}>{props.labels.profitTargetsTitle}</ConfigTitle>
          <Toggle
            checked={limits.profit_targets_enabled}
            onChange={v => {
              if (v && limits.profit_targets.length === 0) {
                patchLimits({
                  profit_targets_enabled: true,
                  profit_targets: [{
                    id: newTargetId(),
                    enabled: true,
                    period: 'daily',
                    value_type: 'amount',
                    value: 100,
                  }],
                })
                return
              }
              patchLimits({ profit_targets_enabled: v })
            }}
          />
        </div>
        <ConfigToggleLabel>{props.labels.profitTargetsToggle}</ConfigToggleLabel>
        {limits.profit_targets_enabled ? (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patchLimits({
                  profit_targets: [
                    ...limits.profit_targets,
                    {
                      id: newTargetId(),
                      enabled: true,
                      period: 'daily',
                      value_type: 'amount',
                      value: 100,
                    },
                  ],
                })}
              >
                {props.labels.addTarget}
              </Button>
            </div>
            {limits.profit_targets.map((row, idx) => (
              <div key={row.id} className="grid grid-cols-12 gap-2 items-end border border-neutral-100 dark:border-neutral-800 rounded-md p-2">
                <div className="col-span-12 sm:col-span-2">
                  <label className="text-xs flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={e => updateTarget(idx, { enabled: e.target.checked })}
                    />
                    {props.labels.enabled}
                  </label>
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <ConfigureSelect
                    label={props.labels.periodLabel}
                    value={row.period}
                    onChange={e => updateTarget(idx, { period: e.target.value as CopyLimitPeriod })}
                    options={periodSelectOptions}
                  />
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <ConfigureSelect
                    label={props.labels.typeLabel}
                    value={row.value_type}
                    onChange={e => updateTarget(idx, { value_type: e.target.value as CopyLimitValueType })}
                    options={valueTypeOptions}
                  />
                </div>
                <div className="col-span-10 sm:col-span-3">
                  <ConfigureInput
                    label={props.labels.targetValue}
                    type="number"
                    min={0.01}
                    step={row.value_type === 'percent' ? 0.1 : 1}
                    value={String(row.value)}
                    onChange={e => updateTarget(idx, { value: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </div>
                <Button
                  className="col-span-2"
                  variant="ghost"
                  size="sm"
                  onClick={() => patchLimits({
                    profit_targets: limits.profit_targets.filter((_, i) => i !== idx),
                  })}
                >
                  {props.labels.remove}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <ConfigTitle info={props.labels.maxRiskIntro}>{props.labels.maxRiskTitle}</ConfigTitle>
          <Toggle
            checked={limits.max_risk_enabled}
            onChange={v => {
              if (v && limits.max_risks.length === 0) {
                patchLimits({
                  max_risk_enabled: true,
                  max_risks: [{
                    id: newRiskId(),
                    enabled: true,
                    period: 'daily',
                    value_type: 'amount',
                    value: 100,
                  }],
                })
                return
              }
              patchLimits({ max_risk_enabled: v })
            }}
          />
        </div>
        <ConfigToggleLabel>{props.labels.maxRiskToggle}</ConfigToggleLabel>
        {limits.max_risk_enabled ? (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patchLimits({
                  max_risks: [
                    ...limits.max_risks,
                    {
                      id: newRiskId(),
                      enabled: true,
                      period: 'daily',
                      value_type: 'amount',
                      value: 100,
                    },
                  ],
                })}
              >
                {props.labels.addRiskRule}
              </Button>
            </div>
            {limits.max_risks.map((row, idx) => (
              <div key={row.id} className="grid grid-cols-12 gap-2 items-end border border-neutral-100 dark:border-neutral-800 rounded-md p-2">
                <div className="col-span-12 sm:col-span-2">
                  <label className="text-xs flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={e => updateRisk(idx, { enabled: e.target.checked })}
                    />
                    {props.labels.enabled}
                  </label>
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <ConfigureSelect
                    label={props.labels.periodLabel}
                    value={row.period}
                    onChange={e => updateRisk(idx, { period: e.target.value as CopyLimitPeriod })}
                    options={periodSelectOptions}
                  />
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <ConfigureSelect
                    label={props.labels.typeLabel}
                    value={row.value_type}
                    onChange={e => updateRisk(idx, { value_type: e.target.value as CopyLimitValueType })}
                    options={valueTypeOptions}
                  />
                </div>
                <div className="col-span-10 sm:col-span-3">
                  <ConfigureInput
                    label={props.labels.riskValue}
                    type="number"
                    min={0.01}
                    step={row.value_type === 'percent' ? 0.1 : 1}
                    value={String(row.value)}
                    onChange={e => updateRisk(idx, { value: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </div>
                <Button
                  className="col-span-2"
                  variant="ghost"
                  size="sm"
                  onClick={() => patchLimits({
                    max_risks: limits.max_risks.filter((_, i) => i !== idx),
                  })}
                >
                  {props.labels.remove}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
