import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { normalizeCopyLimits, type CopyLimitPeriod, type CopyLimitValueType, type CopyLimitsConfig, type MaxRiskRule, type ProfitTargetRule } from '../../lib/copyLimitTypes'
import { DEFAULT_MANUAL_SETTINGS, DEFAULT_MANUAL_TP_LOTS } from '../../lib/defaultManualSettings'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import {
  estimateMultiTradeOrderCount,
  formatMultiTradeTotalOpenTradesPreview,
} from '../../lib/estimateMultiTradeOrders'
import { formatPreviewLotSize, resolvePreviewManualLot } from '../../lib/manualLotSizing'
import { resolveMultiTradePerLegLot } from '../../lib/multiTradeLegUnits'
import type { BrokerAccount, ManualSettings, ManualTpLot } from '../../types/database'

const controlClass = 'w-28 border-0 bg-transparent p-0 text-end text-sm font-medium text-neutral-900 focus:outline-none focus:ring-0 dark:text-neutral-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-100 py-2 last:border-b-0 dark:border-neutral-800">
      <span className="min-w-0 text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  )
}

function Readout({ value }: { value: string }) {
  return <span className="text-end text-sm font-medium text-neutral-900 dark:text-neutral-50">{value}</span>
}

function Choice({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuBox, setMenuBox] = useState<{ top: number; right: number } | null>(null)
  const index = Math.max(0, options.findIndex(option => option.value === value))

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuBox({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
    }
    place()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        className="inline-flex items-center gap-1 text-end text-sm font-medium text-neutral-900 dark:text-neutral-50"
        onClick={() => setOpen(current => !current)}
      >
        {options[index]?.label ?? value}
        <ChevronDown className={`h-3.5 w-3.5 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuBox ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          style={{ top: menuBox.top, right: menuBox.right }}
          className="fixed z-[80] min-w-[9.5rem] overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-950"
        >
          {options.map(option => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`block w-full px-3 py-1.5 text-start text-sm ${
                  selected
                    ? 'font-medium text-teal-700 dark:text-teal-300'
                    : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-900'
                }`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>,
        document.body,
      ) : null}
    </>
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
    <Choice
      value={checked ? 'on' : 'off'}
      options={[
        { value: 'on', label: onLabel },
        { value: 'off', label: offLabel },
      ]}
      onChange={value => onChange(value === 'on')}
    />
  )
}

function NumberField({
  value,
  onCommit,
  min,
  step = 'any',
}: {
  value: number
  onCommit: (value: number) => void
  min?: number
  step?: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
  }, [value])
  return (
    <input
      type="number"
      className={controlClass}
      value={text}
      min={min}
      step={step}
      onChange={event => setText(event.target.value)}
      onBlur={() => {
        const next = Number(text)
        if (!Number.isFinite(next)) {
          setText(String(value))
          return
        }
        if (next !== value) onCommit(next)
      }}
    />
  )
}

function TextField({
  value,
  onCommit,
  placeholder,
}: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(value)
  }, [value])
  return (
    <input
      type="text"
      className={`${controlClass} w-44`}
      value={text}
      placeholder={placeholder}
      onChange={event => setText(event.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text)
      }}
    />
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  )
}

function symbolText(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).join(', ')
  return String(value ?? '')
}

function parseSymbolList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function newLimitId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `limit-${Date.now()}`
}

export function ConfigurationSettingsEditor({
  broker,
  settings,
  copy,
  modalCopy,
  multiTradeEnabled,
  saveError,
  onPatch,
  onError,
}: {
  broker: BrokerAccount
  settings: ManualSettings
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
  multiTradeEnabled: boolean
  saveError: string | null
  onPatch: (patch: Partial<ManualSettings>) => void
  onError: (message: string) => void
}) {
  const cm = modalCopy
  const rangeStyle = settings.trade_style === 'multi'
  const balancePercent = settings.risk_mode === 'dynamic_balance_percent'
  const limits = normalizeCopyLimits(settings.copy_limits)
  const tpLots = (settings.tp_lots?.length ? settings.tp_lots : DEFAULT_MANUAL_TP_LOTS).map(row => ({ ...row }))
  const manualLot = resolvePreviewManualLot({
    manualSettings: {
      risk_mode: balancePercent ? 'dynamic_balance_percent' : 'fixed_lot',
      fixed_lot: finiteNumber(settings.fixed_lot, DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01),
      dynamic_balance_percent: finiteNumber(settings.dynamic_balance_percent, 1),
    },
    accountBalance: resolveBrokerTotalBalance(broker),
  })

  const setTradeStyle = (value: string) => {
    if (value === 'multi' && !multiTradeEnabled) {
      onError(cm.risk.basicPlanTradeStyleLimit)
      return
    }
    if (value === 'multi') onPatch({ trade_style: 'multi', use_signal_entry_price: false })
    else onPatch({ trade_style: 'single' })
  }

  const setLimits = (next: CopyLimitsConfig) => onPatch({ copy_limits: next })

  const updateProfitRule = (id: string, patch: Partial<ProfitTargetRule>) => {
    setLimits({
      ...limits,
      profit_targets: limits.profit_targets.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)),
    })
  }

  const updateRiskRule = (id: string, patch: Partial<MaxRiskRule>) => {
    setLimits({
      ...limits,
      max_risks: limits.max_risks.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)),
    })
  }

  const moveMode = settings.move_sl_to_entry_after_mode ?? 'none'
  const stepPips = finiteNumber(settings.range_step_pips)
  const periods: { value: CopyLimitPeriod; label: string }[] = [
    { value: 'daily', label: cm.stops.periodDaily },
    { value: 'weekly', label: cm.stops.periodWeekly },
    { value: 'monthly', label: cm.stops.periodMonthly },
    { value: 'overall', label: cm.stops.periodOverall },
  ]
  const valueTypes: { value: CopyLimitValueType; label: string }[] = [
    { value: 'amount', label: cm.stops.valueTypeAmount },
    { value: 'percent', label: cm.stops.valueTypePercent },
  ]

  let openTrades = ''
  if (rangeStyle) {
    const legPercent = finiteNumber(settings.multi_trade_leg_percent, DEFAULT_MANUAL_SETTINGS.multi_trade_leg_percent ?? 5)
    const rangeOn = settings.range_trading === true
    const preview = estimateMultiTradeOrderCount({
      manualLot,
      legPercent,
      range: rangeOn
        ? {
            enabled: true,
            percent: finiteNumber(settings.range_percent, DEFAULT_MANUAL_SETTINGS.range_percent ?? 50),
            stepPips,
            distancePips: finiteNumber(settings.range_distance_pips, DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30),
            useSignalEntryRange: settings.use_signal_entry_range === true,
          }
        : undefined,
    })
    const perLeg = resolveMultiTradePerLegLot({ manualLot, legPercent })
    openTrades = formatMultiTradeTotalOpenTradesPreview(perLeg, preview, {
      fallbackSingle: cm.risk.previewFallbackSingle,
      lotsXTrades: cm.risk.previewLotsXTrades,
      lotsXTradesLayered: cm.risk.previewLotsXTradesLayered,
    }, formatPreviewLotSize)
  }

  return (
    <div className="space-y-4">
      {saveError ? <p className="text-sm text-error-600 dark:text-error-400">{saveError}</p> : null}
      <Section title={cm.manualSubTabs.risk}>
        <SettingRow label={cm.risk.tradeStyle}>
          <Choice
            value={rangeStyle ? 'multi' : 'single'}
            options={[
              { value: 'single', label: cm.risk.singleTrade },
              { value: 'multi', label: cm.risk.multiTrades },
            ]}
            onChange={setTradeStyle}
          />
        </SettingRow>
        <SettingRow label={cm.risk.riskMode}>
          <Choice
            value={balancePercent ? 'dynamic_balance_percent' : 'fixed_lot'}
            options={[
              { value: 'fixed_lot', label: cm.risk.fixedLot },
              { value: 'dynamic_balance_percent', label: cm.risk.dynamicBalance },
            ]}
            onChange={value => onPatch({ risk_mode: value as ManualSettings['risk_mode'] })}
          />
        </SettingRow>
        {balancePercent ? (
          <>
            <SettingRow label={cm.risk.dynamicBalance}>
              <NumberField
                value={finiteNumber(settings.dynamic_balance_percent, 1)}
                min={0}
                onCommit={value => onPatch({ dynamic_balance_percent: value })}
              />
            </SettingRow>
            <SettingRow label={cm.risk.dynamicBalanceLotSize}>
              <Readout value={formatPreviewLotSize(manualLot)} />
            </SettingRow>
          </>
        ) : (
          <SettingRow label={copy.lotSize}>
            <NumberField
              value={finiteNumber(settings.fixed_lot, DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01)}
              min={0.01}
              step="0.01"
              onCommit={value => onPatch({ fixed_lot: value })}
            />
          </SettingRow>
        )}
        {rangeStyle ? (
          <>
            <SettingRow label={cm.risk.perLegSize}>
              <NumberField
                value={finiteNumber(settings.multi_trade_leg_percent, 5)}
                min={0.1}
                onCommit={value => onPatch({ multi_trade_leg_percent: value })}
              />
            </SettingRow>
            <SettingRow label={cm.risk.totalOpenTrades}>
              <Readout value={openTrades} />
            </SettingRow>
            <SettingRow label={cm.risk.useSignalRange}>
              <OnOff onLabel={copy.on} offLabel={copy.off}
                checked={settings.use_signal_entry_range === true}
                onChange={value => onPatch({ use_signal_entry_range: value })}
              />
            </SettingRow>
            {settings.use_signal_entry_range === true ? (
              <SettingRow label={cm.risk.useSignalRangePipTolerance}>
                <NumberField
                  value={finiteNumber(settings.signal_entry_pip_tolerance, 10)}
                  min={0}
                  onCommit={value => onPatch({ signal_entry_pip_tolerance: value })}
                />
              </SettingRow>
            ) : null}
            <SettingRow label={cm.risk.rangeLayering}>
              <OnOff onLabel={copy.on} offLabel={copy.off}
                checked={settings.range_trading === true}
                onChange={value => onPatch({ range_trading: value })}
              />
            </SettingRow>
            {settings.range_trading === true ? (
              <>
                <SettingRow label={copy.layeringMode}>
                  <Choice
                    value={settings.range_layering_type === 'pending_order' ? 'pending_order' : 'auto'}
                    options={[
                      { value: 'auto', label: copy.layeringAutomatic },
                      { value: 'pending_order', label: copy.layeringPending },
                    ]}
                    onChange={value => onPatch({ range_layering_type: value as ManualSettings['range_layering_type'] })}
                  />
                </SettingRow>
                <SettingRow label={cm.risk.reservedLot}>
                  <NumberField
                    value={finiteNumber(settings.range_percent, 50)}
                    min={0}
                    onCommit={value => onPatch({ range_percent: value })}
                  />
                </SettingRow>
                <SettingRow label={cm.risk.stepPips}>
                  <Choice
                    value={stepPips > 0 ? 'manual' : 'auto'}
                    options={[
                      { value: 'auto', label: cm.risk.stepModeAuto },
                      { value: 'manual', label: cm.risk.stepModeManual },
                    ]}
                    onChange={value => onPatch({ range_step_pips: value === 'manual' ? Math.max(stepPips, 1) : 0 })}
                  />
                  {stepPips > 0 ? (
                    <NumberField
                      value={stepPips}
                      min={1}
                      onCommit={value => onPatch({ range_step_pips: value })}
                    />
                  ) : null}
                </SettingRow>
                <SettingRow label={cm.risk.rangeDistance}>
                  <NumberField
                    value={finiteNumber(settings.range_distance_pips, 30)}
                    min={0}
                    onCommit={value => onPatch({ range_distance_pips: value })}
                  />
                </SettingRow>
                <SettingRow label={cm.risk.layerTillClose}>
                  <OnOff onLabel={copy.on} offLabel={copy.off}
                    checked={settings.range_layer_till_close === true}
                    onChange={value => onPatch({ range_layer_till_close: value })}
                  />
                </SettingRow>
              </>
            ) : null}
          </>
        ) : (
          <>
            <SettingRow label={cm.risk.singleTpTarget}>
              <Choice
                value={settings.single_tp_target ?? 'farthest'}
                options={[
                  { value: 'farthest', label: cm.risk.singleTpTargetFarthest },
                  ...tpLots
                    .map((row, index) => ({ row, index }))
                    .filter(({ row }) => row.enabled !== false)
                    .map(({ row, index }) => ({
                      value: `tp${index + 1}`,
                      label: row.label?.trim() || `TP${index + 1}`,
                    })),
                ]}
                onChange={value => onPatch({ single_tp_target: value as ManualSettings['single_tp_target'] })}
              />
            </SettingRow>
            <SettingRow label={cm.risk.useSignalEntryPrice}>
              <OnOff onLabel={copy.on} offLabel={copy.off}
                checked={settings.use_signal_entry_price === true}
                onChange={value => onPatch({ use_signal_entry_price: value })}
              />
            </SettingRow>
            {settings.use_signal_entry_price === true ? (
              <SettingRow label={cm.risk.pipToleranceLegacy}>
                <NumberField
                  value={finiteNumber(settings.signal_entry_pip_tolerance, 10)}
                  min={0}
                  onCommit={value => onPatch({ signal_entry_pip_tolerance: value })}
                />
              </SettingRow>
            ) : null}
          </>
        )}
      </Section>

      <Section title={cm.manualSubTabs.stops}>
        <SettingRow label={cm.stops.overrideSl}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.use_predefined_sl_pips === true}
            onChange={value => onPatch({ use_predefined_sl_pips: value })}
          />
        </SettingRow>
        {settings.use_predefined_sl_pips === true ? (
          <SettingRow label={cm.stops.slPips}>
            <NumberField
              value={finiteNumber(settings.predefined_sl_pips, 30)}
              min={0}
              onCommit={value => onPatch({ predefined_sl_pips: value })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={cm.stops.overrideTps}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.use_predefined_tp_pips === true}
            onChange={value => onPatch({ use_predefined_tp_pips: value })}
          />
        </SettingRow>
        {settings.use_predefined_tp_pips === true ? (
          <SettingRow label={cm.stops.overrideTps}>
            <TextField
              value={(settings.predefined_tp_pips ?? []).join(', ')}
              placeholder="20, 40, 60"
              onCommit={value => onPatch({
                predefined_tp_pips: value.split(',').map(item => Number(item.trim())).filter(item => Number.isFinite(item)),
              })}
            />
          </SettingRow>
        ) : null}
        {tpLots.map((row, index) => (
          <SettingRow key={`${row.label}-${index}`} label={row.label?.trim() || `TP${index + 1}`}>
            <NumberField
              value={finiteNumber(row.percent)}
              min={0}
              onCommit={value => {
                const next: ManualTpLot[] = tpLots.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, percent: value } : item
                ))
                onPatch({ tp_lots: next })
              }}
            />
            <OnOff onLabel={copy.on} offLabel={copy.off}
              checked={row.enabled !== false}
              onChange={value => {
                const next = tpLots.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, enabled: value } : item
                ))
                onPatch({ tp_lots: next })
              }}
            />
          </SettingRow>
        ))}
        <LimitRules
          label={cm.stops.profitTargetsToggle}
          enabled={limits.profit_targets_enabled}
          rules={limits.profit_targets}
          periods={periods}
          valueTypes={valueTypes}
          addLabel={cm.stops.addTarget}
          onLabel={copy.on}
          offLabel={copy.off}
          onToggle={value => setLimits({
            ...limits,
            profit_targets_enabled: value,
            profit_targets: value && limits.profit_targets.length === 0
              ? [{ id: newLimitId(), enabled: true, period: 'daily', value_type: 'amount', value: 0 }]
              : limits.profit_targets,
          })}
          onChange={(id, patch) => updateProfitRule(id, patch)}
          onAdd={() => setLimits({
            ...limits,
            profit_targets_enabled: true,
            profit_targets: [...limits.profit_targets, {
              id: newLimitId(),
              enabled: true,
              period: 'daily',
              value_type: 'amount',
              value: 0,
            }],
          })}
        />
        <LimitRules
          label={cm.stops.maxRiskToggle}
          enabled={limits.max_risk_enabled}
          rules={limits.max_risks}
          periods={periods}
          valueTypes={valueTypes}
          addLabel={cm.stops.addRiskRule}
          onLabel={copy.on}
          offLabel={copy.off}
          onToggle={value => setLimits({
            ...limits,
            max_risk_enabled: value,
            max_risks: value && limits.max_risks.length === 0
              ? [{ id: newLimitId(), enabled: true, period: 'daily', value_type: 'amount', value: 0 }]
              : limits.max_risks,
          })}
          onChange={(id, patch) => updateRiskRule(id, patch)}
          onAdd={() => setLimits({
            ...limits,
            max_risk_enabled: true,
            max_risks: [...limits.max_risks, {
              id: newLimitId(),
              enabled: true,
              period: 'daily',
              value_type: 'amount',
              value: 0,
            }],
          })}
        />
      </Section>

      <Section title={cm.manualSubTabs.management}>
        <SettingRow label={cm.strategy.reverseSignal}>
          <OnOff onLabel={copy.on} offLabel={copy.off} checked={settings.reverse_signal === true} onChange={value => onPatch({ reverse_signal: value })} />
        </SettingRow>
        <SettingRow label={cm.strategy.addToExisting}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.add_new_trades_to_existing !== false}
            onChange={value => onPatch({ add_new_trades_to_existing: value })}
          />
        </SettingRow>
        <SettingRow label={cm.strategy.closeOpposite}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.close_on_opposite_signal === true}
            onChange={value => onPatch({ close_on_opposite_signal: value })}
          />
        </SettingRow>
        <SettingRow label={cm.management.moveSlTitle}>
          <Choice
            value={moveMode}
            options={[
              { value: 'none', label: copy.off },
              { value: 'pips', label: cm.management.triggerPips },
              { value: 'rr', label: cm.management.triggerRr },
              { value: 'money', label: cm.management.triggerMoney },
              { value: 'tp_hit', label: cm.management.triggerTpHit },
            ]}
            onChange={value => onPatch({ move_sl_to_entry_after_mode: value as ManualSettings['move_sl_to_entry_after_mode'] })}
          />
        </SettingRow>
        {moveMode !== 'none' && moveMode !== 'tp_hit' ? (
          <SettingRow label={cm.management.triggerTitle}>
            <NumberField
              value={finiteNumber(settings.move_sl_to_entry_after_value, 10)}
              min={0}
              onCommit={value => onPatch({ move_sl_to_entry_after_value: value })}
            />
          </SettingRow>
        ) : null}
        {moveMode === 'tp_hit' ? (
          <SettingRow label={cm.management.triggerTpHit}>
            <NumberField
              value={finiteNumber(settings.move_sl_to_entry_tp_index, 1)}
              min={1}
              step="1"
              onCommit={value => onPatch({ move_sl_to_entry_tp_index: Math.max(1, Math.round(value)) })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={cm.management.trailingTitle}>
          <OnOff onLabel={copy.on} offLabel={copy.off} checked={settings.trailing_enabled === true} onChange={value => onPatch({ trailing_enabled: value })} />
        </SettingRow>
        {settings.trailing_enabled === true ? (
          <>
            <SettingRow label={cm.management.trailStart}>
              <NumberField value={finiteNumber(settings.trailing_start_pips, 20)} min={0} onCommit={value => onPatch({ trailing_start_pips: value })} />
            </SettingRow>
            <SettingRow label={cm.management.trailStep}>
              <NumberField value={finiteNumber(settings.trailing_step_pips, 5)} min={0} onCommit={value => onPatch({ trailing_step_pips: value })} />
            </SettingRow>
            <SettingRow label={cm.management.trailDistance}>
              <NumberField value={finiteNumber(settings.trailing_distance_pips, 10)} min={0} onCommit={value => onPatch({ trailing_distance_pips: value })} />
            </SettingRow>
          </>
        ) : null}
        <SettingRow label={cm.management.orderCommentsTitle}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.order_comments_enabled !== false}
            onChange={value => onPatch({ order_comments_enabled: value })}
          />
        </SettingRow>
      </Section>

      <Section title={cm.manualSubTabs.symbols}>
        <SettingRow label={cm.channelSymbols.tradeOnlyLabel}>
          <TextField
            value={symbolText(settings.symbol_to_trade)}
            placeholder={copy.allSymbols}
            onCommit={value => onPatch({ symbol_to_trade: value.trim() || null })}
          />
        </SettingRow>
        <SettingRow label={cm.channelSymbols.avoidLabel}>
          <TextField
            value={symbolText(settings.symbols_exclude)}
            placeholder={copy.none}
            onCommit={value => onPatch({ symbols_exclude: parseSymbolList(value) })}
          />
        </SettingRow>
      </Section>

      <Section title={cm.manualSubTabs.filters}>
        <SettingRow label={cm.filters.timeFilter}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.time_filter_enabled === true}
            onChange={value => onPatch({ time_filter_enabled: value })}
          />
        </SettingRow>
        {settings.time_filter_enabled ? (
          <SettingRow label={cm.filters.timeFilter}>
            <input
              type="time"
              className={controlClass}
              value={settings.trade_start_time || '00:00'}
              onChange={event => onPatch({ trade_start_time: event.target.value })}
            />
            <input
              type="time"
              className={controlClass}
              value={settings.trade_end_time || '23:59'}
              onChange={event => onPatch({ trade_end_time: event.target.value })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={cm.filters.daysFilter}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.days_filter_enabled === true}
            onChange={value => onPatch({ days_filter_enabled: value })}
          />
        </SettingRow>
        {settings.days_filter_enabled ? (
          <div className="flex flex-wrap gap-1.5 border-b border-neutral-100 py-2 dark:border-neutral-800">
            {([0, 1, 2, 3, 4, 5, 6] as const).map(day => {
              const selected = (settings.trade_days ?? []).includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  className={`text-xs font-medium ${
                    selected
                      ? 'text-neutral-900 dark:text-neutral-50'
                      : 'text-neutral-400 dark:text-neutral-500'
                  }`}
                  onClick={() => {
                    const current = new Set(settings.trade_days ?? [])
                    if (selected) current.delete(day)
                    else current.add(day)
                    onPatch({ trade_days: [...current].sort((a, b) => a - b) })
                  }}
                >
                  {cm.filters.weekdays[String(day) as keyof typeof cm.filters.weekdays]}
                </button>
              )
            })}
          </div>
        ) : null}
        <SettingRow label={cm.filters.newsTrading}>
          <OnOff onLabel={copy.on} offLabel={copy.off}
            checked={settings.news_trading_enabled !== false}
            onChange={value => onPatch({ news_trading_enabled: value })}
          />
        </SettingRow>
      </Section>
    </div>
  )
}

function LimitRules({
  label,
  enabled,
  rules,
  periods,
  valueTypes,
  addLabel,
  onLabel,
  offLabel,
  onToggle,
  onChange,
  onAdd,
}: {
  label: string
  enabled: boolean
  rules: Array<{ id: string; period: CopyLimitPeriod; value_type: CopyLimitValueType; value: number }>
  periods: { value: CopyLimitPeriod; label: string }[]
  valueTypes: { value: CopyLimitValueType; label: string }[]
  addLabel: string
  onLabel: string
  offLabel: string
  onToggle: (value: boolean) => void
  onChange: (id: string, patch: { period?: CopyLimitPeriod; value_type?: CopyLimitValueType; value?: number }) => void
  onAdd: () => void
}) {
  return (
    <>
      <SettingRow label={label}>
        <OnOff onLabel={onLabel} offLabel={offLabel} checked={enabled} onChange={onToggle} />
      </SettingRow>
      {enabled ? rules.map(rule => (
        <div key={rule.id} className="flex flex-wrap items-center justify-end gap-2 border-b border-neutral-100 py-2 dark:border-neutral-800">
          <Choice
            value={rule.period}
            options={periods}
            onChange={value => onChange(rule.id, { period: value as CopyLimitPeriod })}
          />
          <Choice
            value={rule.value_type}
            options={valueTypes}
            onChange={value => onChange(rule.id, { value_type: value as CopyLimitValueType })}
          />
          <NumberField value={rule.value} min={0} onCommit={value => onChange(rule.id, { value })} />
        </div>
      )) : null}
      {enabled ? (
        <button type="button" className="py-2 text-sm font-medium text-teal-700 dark:text-teal-300" onClick={onAdd}>
          {addLabel}
        </button>
      ) : null}
    </>
  )
}
