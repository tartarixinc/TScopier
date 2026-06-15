import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calculator, ChevronDown, ChevronUp, X } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { ConfigureInput, ConfigureSelect } from '../ui/InfoTooltip'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import { interpolate } from '../../i18n/interpolate'
import { pipCalculator, type PipQuote } from '../../lib/pipCalculator'
import { classifySymbol } from '../../lib/pipMath'
import { formatMoneyWithCode } from '../../lib/currency'
import {
  computeRiskLotCalculator,
  manualSettingsFromRiskCalc,
  riskCalcStateFromManualSettings,
  roundLots2,
  type RiskLotCalculatorFormState,
} from '../../lib/riskLotCalculator'
import { computeMinMultiTradeLegPercent } from '../../lib/multiTradeLegUnits'
import type { ManualSettings } from '../../types/database'

function sumEnabledTpPercents(rows: { enabled?: boolean; percent?: number }[]): number {
  return rows.reduce(
    (s, r) => (r.enabled !== false ? s + (Number(r.percent) || 0) : s),
    0,
  )
}

function pipQuoteForSymbol(symbol: string): PipQuote {
  const upper = symbol.trim().toUpperCase()
  if (!upper) {
    return pipCalculator('EURUSD', 0.00001, 5)
  }
  const klass = classifySymbol(upper)
  let point = 0.0001
  let digits = 5
  switch (klass) {
    case 'fx_jpy': point = 0.001; digits = 3; break
    case 'fx_major': point = 0.00001; digits = 5; break
    case 'metal': point = 0.01; digits = 2; break
    case 'index': point = 1; digits = 0; break
    case 'crypto': point = 0.01; digits = 2; break
    case 'energy': point = 0.01; digits = 2; break
    default: point = 0.00001; digits = 5; break
  }
  return pipCalculator(upper, point, digits)
}

function riskPctTone(pct: number): string {
  if (pct > 5) return 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200'
  if (pct > 2) return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
  if (pct > 1) return 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900/40 dark:bg-yellow-950/30 dark:text-yellow-200'
  return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
}

export interface RiskLotCalculatorModalProps {
  open: boolean
  onClose: () => void
  onApply: (patch: Partial<ManualSettings>) => void
  manualSettings: ManualSettings
  initialBalance: number | null
  currency?: string | null
  pipQuote: PipQuote | null
  symbol: string
  copy: ConfigureModalTranslations['risk']['lotCalculator']
  cancelLabel: string
}

function RiskLotCalculatorModalInner({
  open,
  onClose,
  onApply,
  manualSettings,
  initialBalance,
  currency,
  pipQuote: externalPipQuote,
  symbol: initialSymbol,
  copy,
  cancelLabel,
}: RiskLotCalculatorModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const scrollLockRef = useRef<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [form, setForm] = useState<RiskLotCalculatorFormState>(() =>
    riskCalcStateFromManualSettings(manualSettings, initialBalance),
  )

  useEffect(() => {
    if (!open) return
    setForm(riskCalcStateFromManualSettings(manualSettings, initialBalance))
    setAdvancedOpen(false)
  }, [open, manualSettings, initialBalance])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) {
      if (scrollLockRef.current != null) {
        document.body.style.overflow = scrollLockRef.current
        scrollLockRef.current = null
      }
      return
    }
    scrollLockRef.current = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = scrollLockRef.current ?? ''
      scrollLockRef.current = null
    }
  }, [open])

  const effectiveSymbol = (form.symbol || initialSymbol || 'EURUSD').trim().toUpperCase()
  const quote = useMemo(
    () => externalPipQuote ?? pipQuoteForSymbol(effectiveSymbol),
    [externalPipQuote, effectiveSymbol],
  )
  const minLegPercent = useMemo(
    () => computeMinMultiTradeLegPercent(form.fixedLot),
    [form.fixedLot],
  )

  const result = useMemo(
    () =>
      computeRiskLotCalculator(
        {
          accountBalance: form.accountBalance,
          slPips: form.slPips,
          tpPips: form.tpPips,
          tradeStyle: form.tradeStyle,
          legPercent: form.legPercent,
          rangeTrading: form.rangeTrading,
          rangePercent: form.rangePercent,
          rangeStepPips: form.rangeStepPips,
          rangeDistancePips: form.rangeDistancePips,
          fixedLot: form.fixedLot,
          tpLots: form.tpLots,
          winRatePct: form.winRatePct,
          targetRiskPct: form.targetRiskPct,
        },
        quote,
      ),
    [form, quote],
  )

  const fmtMoney = (n: number) =>
    formatMoneyWithCode(n, quote.quoteCurrency ?? currency ?? undefined, { nullAsDash: false })

  const patchForm = (patch: Partial<RiskLotCalculatorFormState>) => {
    setForm(prev => ({ ...prev, ...patch }))
  }

  const setTpPipAt = (idx: number, raw: string) => {
    const n = Math.max(1, Number(raw) || 0)
    setForm(prev => {
      const tpPips = [...prev.tpPips]
      tpPips[idx] = n
      return { ...prev, tpPips }
    })
  }

  const addTpRow = () => {
    setForm(prev => {
      const nextIndex = prev.tpPips.length + 1
      const lastPip = prev.tpPips[prev.tpPips.length - 1] ?? 20
      return {
        ...prev,
        tpPips: [...prev.tpPips, lastPip + 20],
        tpLots: [
          ...prev.tpLots,
          {
            label: `TP${nextIndex}`,
            lot: 0.01,
            percent: 0,
            enabled: true,
          },
        ],
      }
    })
  }

  const removeTpRow = (idx: number) => {
    setForm(prev => ({
      ...prev,
      tpPips: prev.tpPips.filter((_, i) => i !== idx),
      tpLots: prev.tpLots.filter((_, i) => i !== idx),
    }))
  }

  const setTpLotPercent = (idx: number, raw: string) => {
    const n = Math.max(0, Math.min(100, Number(raw) || 0))
    setForm(prev => {
      const tpLots = prev.tpLots.map((r, i) => (i === idx ? { ...r, percent: n } : r))
      return { ...prev, tpLots }
    })
  }

  const toggleTpRow = (idx: number, enabled: boolean) => {
    setForm(prev => {
      const tpLots = prev.tpLots.map((r, i) => (i === idx ? { ...r, enabled } : r))
      return { ...prev, tpLots }
    })
  }

  const tpPercentTotal = useMemo(
    () => sumEnabledTpPercents(form.tpLots),
    [form.tpLots],
  )

  const handleApply = () => {
    onApply(manualSettingsFromRiskCalc(form))
    onClose()
  }

  if (!open) return null

  const riskWarning =
    result.riskPctFull > 5
      ? copy.riskWarningExtreme
      : result.riskPctFull > 2
        ? copy.riskWarningHigh
        : result.riskPctFull > 1
          ? copy.riskWarningModerate
          : null

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-3 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="absolute inset-0 bg-neutral-950/50" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="risk-lot-calculator-title"
        className="relative flex max-h-[min(92vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 animate-modal-in"
      >
        <div className="shrink-0 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400">
              <Calculator className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="risk-lot-calculator-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                {copy.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                {copy.intro}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={copy.close}
              className="shrink-0 rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto md:flex md:overflow-hidden">
          <div className="space-y-4 border-b border-neutral-100 p-5 md:min-h-0 md:flex-[3] md:overflow-y-auto md:border-b-0 md:border-r dark:border-neutral-800">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ConfigureInput
                  label={copy.accountBalance}
                  type="number"
                  min={0}
                  step={1}
                  value={String(form.accountBalance)}
                  onChange={e => patchForm({ accountBalance: Math.max(0, Number(e.target.value) || 0) })}
                />
                <ConfigureInput
                  label={copy.symbol}
                  type="text"
                  hint={copy.symbolHint}
                  value={form.symbol || initialSymbol}
                  onChange={e => patchForm({ symbol: e.target.value.toUpperCase() })}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ConfigureInput
                  label={copy.fixedLot}
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={String(form.fixedLot)}
                  onChange={e => patchForm({ fixedLot: Math.max(0.01, Number(e.target.value) || 0.01) })}
                />
                <ConfigureInput
                  label={copy.targetRiskPct}
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  hint={copy.targetRiskHint}
                  value={form.targetRiskPct != null ? String(form.targetRiskPct) : ''}
                  onChange={e => {
                    const raw = e.target.value
                    patchForm({
                      targetRiskPct: raw === '' ? null : Math.max(0, Number(raw) || 0),
                    })
                  }}
                />
              </div>

              {result.suggestedLot != null && form.targetRiskPct != null && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2 text-sm dark:border-teal-900/50 dark:bg-teal-950/30">
                  <span className="text-teal-900 dark:text-teal-200">
                    {copy.useSuggestedLot}: <strong>{result.suggestedLot.toFixed(2)}</strong>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => patchForm({ fixedLot: result.suggestedLot!, targetRiskPct: null })}
                  >
                    {copy.useSuggestedLot}
                  </Button>
                </div>
              )}

              <ConfigureSelect
                label={copy.tradeStyle}
                value={form.tradeStyle}
                onChange={e => {
                  const v = e.target.value as 'single' | 'multi'
                  patchForm({
                    tradeStyle: v,
                    rangeTrading: v === 'multi' ? form.rangeTrading : false,
                  })
                }}
                options={[
                  { value: 'single', label: copy.singleTrade },
                  { value: 'multi', label: copy.multiTrades },
                ]}
              />

              {form.tradeStyle === 'multi' && (
                <div className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                  <ConfigureInput
                    label={copy.perLegSize}
                    type="number"
                    min={minLegPercent}
                    max={100}
                    step={0.5}
                    value={String(form.legPercent)}
                    onChange={e => {
                      const raw = Number(e.target.value)
                      const next = Number.isFinite(raw)
                        ? Math.max(minLegPercent, Math.min(100, raw))
                        : minLegPercent
                      patchForm({ legPercent: next })
                    }}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-neutral-800 dark:text-neutral-100">{copy.rangeLayering}</span>
                    <Toggle
                      checked={form.rangeTrading}
                      onChange={v => patchForm({ rangeTrading: v })}
                    />
                  </div>
                  {form.rangeTrading && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <ConfigureInput
                        label={copy.rangePercent}
                        type="number"
                        min={0}
                        max={100}
                        value={String(form.rangePercent)}
                        onChange={e => patchForm({ rangePercent: Number(e.target.value) || 0 })}
                      />
                      <ConfigureInput
                        label={copy.rangeStep}
                        type="number"
                        min={1}
                        value={String(form.rangeStepPips)}
                        onChange={e => patchForm({ rangeStepPips: Math.max(1, Number(e.target.value) || 1) })}
                      />
                      <ConfigureInput
                        label={copy.rangeDistance}
                        type="number"
                        min={1}
                        value={String(form.rangeDistancePips)}
                        onChange={e => patchForm({ rangeDistancePips: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {copy.slPips}
                  </span>
                  <label className="flex shrink-0 items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
                      checked={form.usePredefinedSl}
                      onChange={e => patchForm({ usePredefinedSl: e.target.checked })}
                    />
                    <span className="leading-snug">{copy.usePredefinedSl}</span>
                  </label>
                </div>
                <ConfigureInput
                  type="number"
                  min={1}
                  step={1}
                  value={String(form.slPips)}
                  onChange={e => patchForm({ slPips: Math.max(1, Number(e.target.value) || 1) })}
                />
              </div>

              <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{copy.tpLevelsTitle}</p>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{copy.tpLevelsHint}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
                    <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
                        checked={form.usePredefinedTp}
                        onChange={e => patchForm({ usePredefinedTp: e.target.checked })}
                      />
                      <span className="max-w-[9rem] leading-snug sm:max-w-none">{copy.usePredefinedTp}</span>
                    </label>
                    <Button variant="ghost" size="sm" onClick={addTpRow}>{copy.addTp}</Button>
                  </div>
                </div>

                <div className="hidden sm:grid sm:grid-cols-12 sm:gap-2 sm:px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  <span className="col-span-2">{copy.tpLabel.replace('{index}', '')}</span>
                  <span className="col-span-3">{copy.tpPipsCol}</span>
                  <span className="col-span-3">{copy.tpPercentCol}</span>
                  <span className="col-span-2">{copy.enabled}</span>
                  <span className="col-span-2" />
                </div>

                {form.tpPips.map((pips, idx) => {
                  const row = form.tpLots[idx] ?? {
                    label: `TP${idx + 1}`,
                    lot: 0.01,
                    percent: 0,
                    enabled: true,
                  }
                  return (
                    <div key={`calc-tp-${idx}`} className="grid grid-cols-12 items-end gap-2">
                      <span className="col-span-12 sm:col-span-2 pb-2 text-xs font-medium text-neutral-700 dark:text-neutral-300 sm:pb-0 sm:self-center">
                        {row.label || interpolate(copy.tpLabel, { index: String(idx + 1) })}
                      </span>
                      <div className="col-span-5 sm:col-span-3">
                        <ConfigureInput
                          label={copy.tpPipsCol}
                          type="number"
                          min={1}
                          step={1}
                          value={String(pips)}
                          onChange={e => setTpPipAt(idx, e.target.value)}
                        />
                      </div>
                      <div className="col-span-5 sm:col-span-3">
                        <ConfigureInput
                          label={copy.tpPercentCol}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          disabled={row.enabled === false}
                          value={String(row.percent ?? 0)}
                          onChange={e => setTpLotPercent(idx, e.target.value)}
                        />
                      </div>
                      <label className="col-span-2 flex items-center gap-1.5 self-center pb-2 text-xs sm:pb-0">
                        <input
                          type="checkbox"
                          checked={row.enabled !== false}
                          onChange={e => toggleTpRow(idx, e.target.checked)}
                        />
                        <span className="sm:hidden">{copy.enabled}</span>
                      </label>
                      <Button
                        className="col-span-12 sm:col-span-2 sm:mb-1"
                        variant="ghost"
                        size="sm"
                        disabled={form.tpPips.length <= 1}
                        onClick={() => removeTpRow(idx)}
                      >
                        {copy.remove}
                      </Button>
                    </div>
                  )
                })}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-2 text-xs dark:border-neutral-700">
                  <span className="text-neutral-600 dark:text-neutral-400">
                    {copy.tpPercentTotal}{' '}
                    <strong className={clsx(
                      'font-semibold',
                      tpPercentTotal === 100 ? 'text-emerald-600' : 'text-amber-600',
                    )}>
                      {tpPercentTotal}%
                    </strong>{' '}
                    / 100%
                  </span>
                  {tpPercentTotal !== 100 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {tpPercentTotal < 100
                        ? interpolate(copy.tpUnallocated, { pct: String(100 - tpPercentTotal) })
                        : copy.tpOverCap}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium text-neutral-800 dark:text-neutral-100"
                  onClick={() => setAdvancedOpen(v => !v)}
                >
                  {copy.advanced}
                  {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {advancedOpen && (
                  <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
                    <ConfigureInput
                      label={copy.winRate}
                      type="number"
                      min={1}
                      max={99}
                      step={1}
                      hint={copy.winRateHint}
                      value={form.winRatePct != null ? String(form.winRatePct) : ''}
                      onChange={e => {
                        const raw = e.target.value
                        patchForm({
                          winRatePct: raw === '' ? null : Math.max(1, Math.min(99, Number(raw) || 0)),
                        })
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <aside className="flex flex-col bg-neutral-50 dark:bg-neutral-800/30 md:min-h-0 md:flex-[2] md:overflow-hidden">
              <h3 className="shrink-0 border-b border-neutral-200 px-5 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-700 dark:text-neutral-50">
                {copy.resultsTitle}
              </h3>

              <div className="space-y-3 overflow-y-auto p-5 md:min-h-0 md:flex-1 md:overscroll-contain">

              <div className={clsx('rounded-lg border px-3 py-2.5', riskPctTone(result.riskPctFull))}>
                <p className="text-xs uppercase tracking-wide opacity-80">{copy.riskPct}</p>
                <p className="text-2xl font-semibold tabular-nums">{result.riskPctFull.toFixed(2)}%</p>
                <p className="mt-1 text-sm tabular-nums">{fmtMoney(result.riskFullBasket)}</p>
                {riskWarning && <p className="mt-2 text-xs">{riskWarning}</p>}
              </div>

              {result.riskImmediateOnly != null && (
                <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.riskImmediate}</p>
                  <p className="text-sm font-semibold tabular-nums">{fmtMoney(result.riskImmediateOnly)}</p>
                  {result.riskPctImmediate != null && (
                    <p className="text-xs text-neutral-500">{result.riskPctImmediate.toFixed(2)}%</p>
                  )}
                </div>
              )}

              <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.rewardTotal}</p>
                <p className="text-sm font-semibold tabular-nums">{fmtMoney(result.totalReward)}</p>
                {result.rewardRiskRatio != null && (
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                    {copy.rewardRiskRatio}: 1:{result.rewardRiskRatio.toFixed(2)}
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{copy.legSummary}</p>
                {result.legs.fallsBackSingle || form.tradeStyle === 'single' ? (
                  <p className="mt-1">
                    {interpolate(copy.legSummarySingle, { lot: String(form.fixedLot) })}
                  </p>
                ) : (
                  <>
                    <p className="mt-1">
                      {interpolate(copy.legSummaryMulti, {
                        total: String(result.legs.totalLegs),
                        lot: String(result.legs.perLegLot),
                        immediate: String(result.legs.immediateLegs),
                        pending: String(result.legs.pendingLegs),
                      })}
                    </p>
                    {form.rangeTrading && result.legs.effectiveRangeSpanPips != null && (
                      <p className="mt-1 text-xs text-neutral-500">
                        {interpolate(copy.legSummaryRange, {
                          distance: String(result.legs.effectiveRangeSpanPips),
                          pending: String(result.legs.pendingLegs),
                          step: String(form.rangeStepPips),
                        })}
                      </p>
                    )}
                  </>
                )}
              </div>

              {result.lossesToRuin != null && (
                <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.lossesToRuin}</p>
                  <p className="text-lg font-semibold tabular-nums">{result.lossesToRuin}</p>
                </div>
              )}

              {result.riskOfRuinPct != null && (
                <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.riskOfRuin}</p>
                  <p className="text-lg font-semibold tabular-nums">{result.riskOfRuinPct.toFixed(1)}%</p>
                </div>
              )}

              {result.rewardRows.length > 0 && (
                <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">{copy.perTpReward}</p>
                  <ul className="space-y-1 text-xs">
                    {result.rewardRows.map(row => (
                      <li key={`${row.label}-${row.pips}-${row.percent}`} className="flex justify-between gap-2 tabular-nums">
                        <span>
                          {row.label}: {roundLots2(row.lots)} lots @ {row.pips}p ({row.percent}%)
                        </span>
                        <span>{fmtMoney(Number(row.reward.toFixed(2)))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.notes.includes('multi_trade_fallback_min_lot') && (
                <p className="text-xs text-amber-700 dark:text-amber-300">{copy.fallbackSingleNote}</p>
              )}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.brokerPreviewNote}</p>
              </div>
            </aside>
        </div>

        <div className="shrink-0 flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <Button type="button" variant="ghost" onClick={onClose}>{cancelLabel}</Button>
          <Button type="button" onClick={handleApply}>{copy.apply}</Button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

export const RiskLotCalculatorModal = memo(RiskLotCalculatorModalInner)
