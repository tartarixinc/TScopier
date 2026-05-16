import { useEffect, useState, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus, Trash2, Server, Activity, GitBranch, Eye, DollarSign,
  SlidersHorizontal, Radio, Target, Filter, Wallet,
  ArrowLeftRight, ChevronDown, Brain, Settings2,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Toggle } from '../../components/ui/Toggle'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Alert } from '../../components/ui/Alert'
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { BrokerServerSelect } from '../../components/ui/BrokerServerSelect'
import { metatraderApi } from '../../lib/metatraderapi'
import {
  inferBrokerLabelFromServer,
  resolveLinkedAccountType,
  resolveMtServerCandidate,
  type LinkedAccountType,
} from '../../lib/brokerFromServer'
import { estimateMultiTradeOrderCount } from '../../lib/estimateMultiTradeOrders'
import { pipCalculator, pipValueForLots, type PipQuote } from '../../lib/pipCalculator'
import { classifySymbol } from '../../lib/pipMath'
import type { BrokerAccount, ManualSettings, ManualTpLot } from '../../types/database'
import {
  DEFAULT_CHANNEL_FILTERS,
  normalizeChannelFilters,
  normalizeChannelMessageFiltersMap,
  type ChannelFilterDecision,
  type ChannelFilterKey,
  type ChannelFilters,
  type ChannelMessageFiltersMap,
} from '../../lib/channelMessageFilters'

interface ChannelOption {
  id: string
  display_name: string
  channel_username: string
  is_active: boolean
  created_at: string
}

// ── Channel keyword filters ────────────────────────────────────────────────

const CHANNEL_FILTER_CATEGORIES: Array<{
  key: ChannelFilterKey
  label: string
  example: string
}> = [
  { key: 'close_full',          label: 'Close full position',   example: 'e.g. "close", "exit trade", "flatten"' },
  { key: 'close_half',          label: 'Close half / partial',  example: 'e.g. "close half", "take 50%"' },
  { key: 'break_even',          label: 'Break-even',            example: 'e.g. "move SL to entry", "BE now"' },
  { key: 'modify_sl',           label: 'Adjust SL',             example: 'e.g. "move SL to 4500"' },
  { key: 'modify_tp',           label: 'Adjust TP',             example: 'e.g. "change TP to 4600"' },
  { key: 'close_tp_levels',     label: 'Close at named TP',     example: 'e.g. "close TP1", "TP2 hit"' },
  { key: 'close_all',           label: 'Close all open trades', example: 'e.g. "close all", "flatten all"' },
  { key: 'close_worse_entries', label: 'Close worse entries',   example: 'e.g. "close worse entries"' },
  { key: 'delete_pendings',     label: 'Cancel pending orders', example: 'e.g. "cancel limit", "delete pending"' },
  { key: 'reverse',             label: 'Reverse direction',     example: 'flips buy ↔ sell on entry' },
]

interface BrokerForm {
  label: string
  platform: 'MT4' | 'MT5'
  account_number: string
  account_password: string
  broker_server: string
}

const emptyForm: BrokerForm = {
  label: '',
  platform: 'MT5',
  account_number: '',
  account_password: '',
  broker_server: '',
}

function normalizeSignalChannelIds(b: BrokerAccount | undefined): string[] {
  const raw = b?.signal_channel_ids
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return []
}

function getOldestChannel(channels: ChannelOption[]): ChannelOption | undefined {
  if (!channels.length) return undefined
  return [...channels].reduce((oldest, ch) => {
    const t = Date.parse(ch.created_at)
    const ot = Date.parse(oldest.created_at)
    const tOk = Number.isFinite(t)
    const oOk = Number.isFinite(ot)
    if (!tOk && !oOk) return ch.id < oldest.id ? ch : oldest
    if (!tOk) return oldest
    if (!oOk) return ch
    if (t !== ot) return t < ot ? ch : oldest
    return ch.id < oldest.id ? ch : oldest
  })
}

/** When false, the configure modal only shows manual settings (AI tab hidden). */
const AI_CONFIGURATION_ENABLED = false

interface AccountConfigDraft {
  mode: 'ai' | 'manual'
  channelIds: string[]
  manualSettings: ManualSettings
  channelFilters: ChannelMessageFiltersMap
}

/**
 * Build the channel-filters map for a broker draft. Every channel that may be
 * referenced by the modal (selected today, plus everything in `channelOptions`
 * so toggling a checkbox doesn't drop a previously-edited row) gets defaults.
 * Existing entries in `prior` win so we don't clobber in-session edits.
 */
function buildChannelFiltersDraft(
  channels: ChannelOption[],
  selectedIds: string[],
  persisted: ChannelMessageFiltersMap = {},
  prior: ChannelMessageFiltersMap = {},
): ChannelMessageFiltersMap {
  const keys = new Set<string>([...channels.map(c => c.id), ...selectedIds])
  const out: ChannelMessageFiltersMap = {}
  for (const id of keys) {
    out[id] = prior[id]
      ? normalizeChannelFilters(prior[id])
      : normalizeChannelFilters(persisted[id])
  }
  return out
}

const DEFAULT_MANUAL_TP_LOTS: ManualTpLot[] = [
  { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
  { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
  { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
]

const DEFAULT_MANUAL_SETTINGS: ManualSettings = {
  schema_version: 1,
  symbol_mapping: {},
  symbol_prefix: '',
  symbol_suffix: '',
  symbol_to_trade: null,
  symbols_exclude: [],
  risk_mode: 'fixed_lot',
  fixed_lot: 0.01,
  dynamic_balance_percent: 1,
  tp_lots: DEFAULT_MANUAL_TP_LOTS,
  multi_trade_leg_percent: 5,
  trade_style: 'single',
  range_trading: false,
  range_percent: 50,
  range_step_pips: 3,
  range_distance_pips: 30,
  close_worse_entries: false,
  close_worse_entries_pips: 30,
  reverse_signal: false,
  use_signal_entry_price: false,
  signal_entry_pip_tolerance: 10,
  use_predefined_sl_pips: false,
  predefined_sl_pips: 30,
  use_predefined_tp_pips: false,
  predefined_tp_pips: [20, 40, 60],
  rr_for_sl_enabled: false,
  rr_for_sl: 1,
  rr_for_tps_enabled: false,
  rr_for_tps: [1, 2, 3],
  pending_expiry_hours: 1,
  add_new_trades_to_existing: true,
  move_sl_to_entry_after_mode: 'none',
  move_sl_to_entry_after_value: 10,
  move_sl_to_entry_tp_index: 1,
  move_sl_to_entry_type: 'sl_only',
  breakeven_offset_pips: 10,
  partial_close_percent: 25,
  half_close_percent: 50,
  trailing_enabled: false,
  trailing_start_pips: 20,
  trailing_step_pips: 5,
  trailing_distance_pips: 10,
  close_on_opposite_signal: false,
  time_filter_enabled: false,
  trade_start_time: '00:00',
  trade_end_time: '23:59',
  days_filter_enabled: false,
  trade_days: [1, 2, 3, 4, 5],
  allow_high_impact_news: false,
  close_before_news_minutes: 10,
  resume_after_news_minutes: 10,
}

/** Split `total` across `count` slots as non-negative integers that sum exactly to `total`. */
function splitIntEqual(count: number, total: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(total / count)
  const rem = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0))
}

function cloneTpLots(rows: ManualTpLot[] | undefined, fallback: ManualTpLot[]): ManualTpLot[] {
  const src = rows?.length ? rows : fallback
  return src.map(r => ({ ...r, lot: r.lot ?? 0.01 }))
}

function clonePredefinedTpPips(list: number[] | undefined): number[] {
  const fallback = DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60]
  const src = list?.length ? list : fallback
  return src.map(n => (Number.isFinite(Number(n)) ? Number(n) : 0))
}

/** Sum percent across enabled rows. Disabled rows always contribute 0. */
function sumEnabledTpPercents(rows: ManualTpLot[]): number {
  return rows.reduce((s, r) => s + (r.enabled ? Math.max(0, Number(r.percent) || 0) : 0), 0)
}

/**
 * Apply `rawNew` percent to `editedIdx`, **without touching any other row**.
 * The value is clamped to the remaining budget so the enabled total can never
 * exceed 100%. Disabled rows are pinned at 0%.
 */
function applyTpPercentEdit(rows: ManualTpLot[], editedIdx: number, rawNew: number): ManualTpLot[] {
  const out = cloneTpLots(rows, DEFAULT_MANUAL_TP_LOTS)
  if (editedIdx < 0 || editedIdx >= out.length) return out

  const target = out[editedIdx]!
  if (!target.enabled) {
    out[editedIdx] = { ...target, percent: 0 }
    return out
  }

  const requested = Math.max(0, Math.min(100, Math.round(Number(rawNew) || 0)))
  const otherEnabledSum = out.reduce(
    (s, r, i) => (i !== editedIdx && r.enabled ? s + Math.max(0, Number(r.percent) || 0) : s),
    0,
  )
  const budget = Math.max(0, 100 - otherEnabledSum)
  const next = Math.min(requested, budget)
  out[editedIdx] = { ...target, percent: next }
  return out
}

/** Ensures disabled rows show 0% and percents stay in 0..100 — no auto-redistribute. */
function sanitizeTpLots(rows: ManualTpLot[]): ManualTpLot[] {
  return rows.map(r => ({
    ...r,
    lot: r.lot ?? 0.01,
    percent: r.enabled ? Math.max(0, Math.min(100, Math.round(Number(r.percent) || 0))) : 0,
  }))
}

function normalizeManualSettings(raw: unknown): ManualSettings {
  const j = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const map = j.symbol_mapping && typeof j.symbol_mapping === 'object' ? j.symbol_mapping as Record<string, unknown> : {}
  const tpLotsRaw = Array.isArray(j.tp_lots) ? j.tp_lots : DEFAULT_MANUAL_TP_LOTS
  const tpLots = tpLotsRaw.map((x, i) => {
    const row = (x && typeof x === 'object') ? x as Record<string, unknown> : {}
    const pct = Number(row.percent)
    return {
      label: String(row.label ?? `TP${i + 1}`),
      lot: Number(row.lot ?? 0.01) || 0.01,
      percent: Number.isFinite(pct) && pct > 0 ? pct : 0,
      enabled: row.enabled !== false,
    } as ManualTpLot
  })
  const legPctRaw = Number(j.multi_trade_leg_percent)
  const legPct = Number.isFinite(legPctRaw) && legPctRaw > 0 ? Math.min(100, legPctRaw) : DEFAULT_MANUAL_SETTINGS.multi_trade_leg_percent

  const merged = { ...DEFAULT_MANUAL_SETTINGS, ...(j as ManualSettings) }
  // Drop legacy keys if they sneak in from older DB rows.
  delete (merged as Record<string, unknown>).multi_tp_volume_mode
  delete (merged as Record<string, unknown>).multi_trade_max_legs
  delete (merged as Record<string, unknown>).range_total_lot

  const readNumber = (key: string, fallback: number): number => {
    const v = Number((j as Record<string, unknown>)[key])
    return Number.isFinite(v) ? v : fallback
  }
  const rangePercent = Math.max(0, Math.min(100, readNumber('range_percent', DEFAULT_MANUAL_SETTINGS.range_percent ?? 50)))
  const rangeStepPips = Math.max(0, readNumber('range_step_pips', DEFAULT_MANUAL_SETTINGS.range_step_pips ?? 3))
  const rangeDistancePips = Math.max(0, readNumber('range_distance_pips', DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30))
  const closeWorseEntries = (j as Record<string, unknown>).close_worse_entries === true
  const closeWorseEntriesPips = Math.max(0, readNumber('close_worse_entries_pips', DEFAULT_MANUAL_SETTINGS.close_worse_entries_pips ?? 30))

  // Manual control: keep whatever the user saved. Only seed an equal split when
  // there is literally nothing enabled with a positive percent (empty / legacy row).
  const tpSanitized = sanitizeTpLots(tpLots)
  let tpFinal = tpSanitized
  if (sumEnabledTpPercents(tpSanitized) === 0) {
    const enabledCount = tpSanitized.filter(r => r.enabled).length
    if (enabledCount > 0) {
      const parts = splitIntEqual(enabledCount, 100)
      let k = 0
      tpFinal = tpSanitized.map(r => (r.enabled ? { ...r, percent: parts[k++] ?? 0 } : { ...r, percent: 0 }))
    }
  }

  return {
    ...merged,
    multi_trade_leg_percent: legPct,
    range_percent: rangePercent,
    range_step_pips: rangeStepPips,
    range_distance_pips: rangeDistancePips,
    close_worse_entries: closeWorseEntries,
    close_worse_entries_pips: closeWorseEntriesPips,
    use_signal_entry_price: (j as Record<string, unknown>).use_signal_entry_price === true,
    signal_entry_pip_tolerance: Math.max(0, readNumber('signal_entry_pip_tolerance', DEFAULT_MANUAL_SETTINGS.signal_entry_pip_tolerance ?? 10)),
    symbol_mapping: Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
    symbols_exclude: Array.isArray(j.symbols_exclude) ? j.symbols_exclude.map(String).map(s => s.toUpperCase()) : [],
    tp_lots: tpFinal,
    predefined_tp_pips: Array.isArray(j.predefined_tp_pips) ? j.predefined_tp_pips.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.predefined_tp_pips,
    rr_for_tps: Array.isArray(j.rr_for_tps) ? j.rr_for_tps.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.rr_for_tps,
    trade_days: Array.isArray(j.trade_days) ? j.trade_days.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.trade_days,
    pending_expiry_hours: (() => {
      const peRaw = readNumber('pending_expiry_hours', DEFAULT_MANUAL_SETTINGS.pending_expiry_hours ?? 1)
      if (peRaw <= 0) return 0
      return Math.max(1, Math.min(24, Math.floor(peRaw)))
    })(),
  }
}

/** Settings required for reverse flip (planner also requires signal entry anchor at runtime). */
function reverseSignalPlannerGateSettingsOk(ms: ManualSettings): boolean {
  if (ms.use_predefined_sl_pips !== true || ms.use_predefined_tp_pips !== true) return false
  const sl = Number(ms.predefined_sl_pips)
  if (!Number.isFinite(sl) || sl <= 0) return false
  const tps = (ms.predefined_tp_pips ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
  return tps.length > 0
}

function getPlatformIconPath(platform: string): string | null {
  const key = platform.trim()
  if (!key) return null
  return `/${key}.png`
}

function PlatformIcon({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const iconPath = getPlatformIconPath(platform)
  if (!iconPath || failed) return <Server className="w-4 h-4 text-primary-600" />
  return (
    <img
      src={iconPath}
      alt={`${platform} icon`}
      className="w-8 h-8 object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatBrokerMoney(value: number | null | undefined, currency?: string | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const formatted = value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const cur = (currency ?? '').trim()
  return cur ? `${formatted} ${cur}` : formatted
}

function accountTypeValueClass(type: LinkedAccountType | undefined): string {
  if (type === 'Demo') return 'font-semibold text-amber-700 dark:text-amber-300'
  if (type === 'Live') return 'font-semibold text-teal-700 dark:text-teal-300'
  return 'text-neutral-900 dark:text-neutral-50'
}

function AccountDetailCell({
  label,
  value,
  className,
}: {
  label: string
  value: ReactNode
  className?: string
}) {
  return (
    <div className={clsx('min-w-0 px-4 py-2.5', className)}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50 truncate" title={typeof value === 'string' ? value : undefined}>
        {value}
      </p>
    </div>
  )
}

type ConfigTabId = 'mode' | 'channels'
type ManualSubTabId = 'symbol_routing' | 'risk' | 'stops' | 'management' | 'filters' | 'strategy'

interface TabDef {
  id: ConfigTabId
  label: string
  icon: typeof SlidersHorizontal
}

interface ManualSubTabDef {
  id: ManualSubTabId
  label: string
  icon: typeof SlidersHorizontal
}

const ALL_TABS: TabDef[] = [
  { id: 'mode', label: 'Trade', icon: SlidersHorizontal },
  { id: 'channels', label: 'Channels', icon: Radio },
]

const MANUAL_SUB_TABS: ManualSubTabDef[] = [
  { id: 'symbol_routing', label: 'Symbol Routing', icon: ArrowLeftRight },
  { id: 'risk', label: 'Risk & Entry', icon: Wallet },
  { id: 'stops', label: 'Targets', icon: Target },
  { id: 'management', label: 'Auto-Management', icon: Settings2 },
  { id: 'filters', label: 'Filters', icon: Filter },
  { id: 'strategy', label: 'Strategy', icon: Brain },
]

export function AccountConfigPage() {
  const { user } = useAuth()
  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([])
  const [configAccount, setConfigAccount] = useState<BrokerAccount | null>(null)
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({
    mode: 'manual',
    channelIds: [],
    manualSettings: { ...DEFAULT_MANUAL_SETTINGS },
    channelFilters: {},
  })
  const [activeTab, setActiveTab] = useState<ConfigTabId>('mode')
  const [activeManualSubTab, setActiveManualSubTab] = useState<ManualSubTabId>('symbol_routing')
  const [symbolMappingText, setSymbolMappingText] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [configSavedAt, setConfigSavedAt] = useState<number | null>(null)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showAddBroker, setShowAddBroker] = useState(false)
  const [form, setForm] = useState<BrokerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  const [brokerAccountTypes, setBrokerAccountTypes] = useState<Record<string, LinkedAccountType>>({})

  const multiTradePreview = useMemo(() => {
    const ms = configDraft.manualSettings
    const manualLot = Number(ms.fixed_lot ?? 0.01) || 0.01
    const legPct = Number(ms.multi_trade_leg_percent ?? 5) || 5
    const range = ms.range_trading
      ? {
          enabled: true,
          percent: Number(ms.range_percent ?? 50) || 0,
          stepPips: Number(ms.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips) || 0,
          distancePips: Number(ms.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0,
        }
      : undefined
    return estimateMultiTradeOrderCount({ manualLot, legPercent: legPct, range })
  }, [
    configDraft.manualSettings.fixed_lot,
    configDraft.manualSettings.multi_trade_leg_percent,
    configDraft.manualSettings.range_trading,
    configDraft.manualSettings.range_percent,
    configDraft.manualSettings.range_step_pips,
    configDraft.manualSettings.range_distance_pips,
  ])

  const brokersNeedingReconnect = useMemo(
    () => brokers.filter(b => b.connection_status === 'error'),
    [brokers],
  )

  const tpLegPercentTotal = useMemo(() => {
    const rows = configDraft.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
    return rows.filter(r => r.enabled).reduce((s, r) => s + (Number(r.percent) || 0), 0)
  }, [configDraft.manualSettings.tp_lots])

  /**
   * Live pip quote for the Account Config page.
   *
   * Why we derive `point` / `digits` from the symbol class instead of calling
   * /SymbolParams: this panel is an editor, not an executor. The broker round-
   * trip would add latency to every keystroke and we already have the trader-
   * conventional defaults baked into `pipCalculator`. The actual trade
   * execution uses real broker data (see worker/src/tradeExecutor.ts), so
   * server-side risk pricing is always exact.
   *
   * `null` means the user hasn't entered a symbol (or entered more than one).
   * Hints in that case fall back to the legacy static text.
   */
  const livePipQuote: PipQuote | null = useMemo(() => {
    const raw = (configDraft.manualSettings.symbol_to_trade ?? '').trim()
    if (!raw) return null
    // Symbol-to-Trade is a whitelist; only compute when there's exactly one
    // symbol so the hint can't lie about an ambiguous multi-symbol config.
    const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    if (parts.length !== 1) return null
    const symbol = parts[0].toUpperCase()
    const klass = classifySymbol(symbol)
    // Trader-conventional broker quote precision per class. These mirror the
    // pip price floors inside `pipCalculator` so the displayed pip value
    // always matches what the planner will use on a sane 2/3/4/5-digit
    // broker.
    let point = 0.0001
    let digits = 5
    switch (klass) {
      case 'fx_jpy':       point = 0.001;   digits = 3; break
      case 'fx_major':     point = 0.00001; digits = 5; break
      case 'metal':        point = 0.01;    digits = 2; break
      case 'index':        point = 1;       digits = 0; break
      case 'crypto':       point = 0.01;    digits = 2; break
      case 'energy':       point = 0.01;    digits = 2; break
      default:             point = 0.00001; digits = 5; break
    }
    return pipCalculator(symbol, point, digits)
  }, [configDraft.manualSettings.symbol_to_trade])

  /**
   * Format a per-pip hint for the configured fixed_lot, e.g.
   * `"At 0.10 lot on XAUUSD: 1 pip ≈ $1.00 (~$10.00 per 10 pips)"`.
   * Returns null when there's no single symbol set yet so callers can fall
   * back to their original static text.
   */
  const formatPipHint = useMemo(() => {
    return (pipCount: number): string | null => {
      if (!livePipQuote) return null
      const fixedLot = Number(configDraft.manualSettings.fixed_lot ?? 0.01) || 0.01
      const perPip = pipValueForLots(livePipQuote, fixedLot)
      if (perPip <= 0) return null
      const ccy = livePipQuote.quoteCurrency ?? ''
      const fmt = (n: number) => (ccy === 'JPY' ? `¥${n.toFixed(0)}` : `$${n.toFixed(2)}`)
      const symbol = (configDraft.manualSettings.symbol_to_trade ?? '').trim()
      const head = `At ${fixedLot.toFixed(2)} lot on ${symbol.toUpperCase()}: 1 pip ≈ ${fmt(perPip)}`
      if (pipCount > 0) {
        return `${head} (~${fmt(perPip * pipCount)} per ${pipCount} pips)`
      }
      return head
    }
  }, [livePipQuote, configDraft.manualSettings.fixed_lot, configDraft.manualSettings.symbol_to_trade])

  useEffect(() => {
    if (!user) return
    void loadData()
  }, [user])

  useEffect(() => {
    if (configSavedAt == null) return
    const t = setTimeout(() => setConfigSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [configSavedAt])

  const syncBrokerAccountTypes = async (list: BrokerAccount[]) => {
    const linked = list.filter(b => {
      const uuid = (b.metaapi_account_id ?? '').trim()
      return uuid.length > 0 && !uuid.includes('|')
    })
    if (linked.length === 0) return

    const fromServer: Record<string, LinkedAccountType> = {}
    for (const b of list) {
      const inferred = resolveLinkedAccountType(undefined, resolveMtServerCandidate(b, b.broker_server))
      if (inferred) fromServer[b.id] = inferred
    }
    setBrokerAccountTypes(prev => ({ ...fromServer, ...prev }))

    const results = await Promise.allSettled(
      linked.map(async b => {
        const { summary } = await metatraderApi.summary(b.id)
        const accountType = resolveLinkedAccountType(summary.type, resolveMtServerCandidate(b, b.broker_server))
        return { id: b.id, accountType }
      }),
    )
    const fromMt: Record<string, LinkedAccountType> = {}
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.accountType) {
        fromMt[r.value.id] = r.value.accountType
      }
    }
    if (Object.keys(fromMt).length > 0) {
      setBrokerAccountTypes(prev => ({ ...prev, ...fromMt }))
    }
  }

  const loadData = async () => {
    const [brokersRes, channelsRes] = await Promise.all([
      supabase.from('broker_accounts').select('*').eq('user_id', user!.id).order('created_at'),
      supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,is_active,created_at')
        .eq('user_id', user!.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false }),
    ])
    const nextBrokers = (brokersRes.data ?? []) as BrokerAccount[]
    setBrokers(nextBrokers)
    setChannelOptions((channelsRes.data ?? []) as ChannelOption[])
    setLoading(false)
    void syncBrokerAccountTypes(nextBrokers)
  }

  // ── Configure modal ────────────────────────────────────────────────────

  const openConfigureModal = (broker: BrokerAccount) => {
    const fresh = brokers.find(b => b.id === broker.id) ?? broker
    const persistedIds = normalizeSignalChannelIds(fresh)
    const restricts = fresh.enforce_signal_channel_filter === true
    let channelIds: string[]
    if (channelOptions.length === 1 && channelOptions[0]) {
      channelIds = [channelOptions[0].id]
    } else if (channelOptions.length > 1) {
      channelIds = restricts && persistedIds.length > 0 ? persistedIds : channelOptions.map(c => c.id)
    } else {
      channelIds = persistedIds
    }
    setConfigAccount(fresh)
    setActiveTab('mode')
    setActiveManualSubTab('symbol_routing')
    const manualSettings = normalizeManualSettings(fresh.manual_settings)
    setConfigDraft({
      mode: AI_CONFIGURATION_ENABLED && fresh.copier_mode !== 'manual' ? 'ai' : 'manual',
      channelIds,
      manualSettings,
      channelFilters: buildChannelFiltersDraft(
        channelOptions,
        channelIds,
        normalizeChannelMessageFiltersMap(fresh.channel_message_filters),
      ),
    })
    setSymbolMappingText(
      Object.entries(manualSettings.symbol_mapping ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    )
  }

  const closeConfigureModal = () => {
    setConfigAccount(null)
    setSymbolMappingText('')
    setError('')
  }

  const toggleDraftChannel = (channelId: string) => {
    setConfigDraft(prev => {
      const willEnable = !prev.channelIds.includes(channelId)
      const channelIds = willEnable
        ? [...prev.channelIds, channelId]
        : prev.channelIds.filter(id => id !== channelId)
      // Seed filters for a freshly-checked channel; leave existing rows alone
      // when un-checking so the user's prior choices return if they re-enable.
      const channelFilters = willEnable && !prev.channelFilters[channelId]
        ? { ...prev.channelFilters, [channelId]: { ...DEFAULT_CHANNEL_FILTERS } }
        : prev.channelFilters
      return { ...prev, channelIds, channelFilters }
    })
  }

  const setChannelFilter = (
    channelId: string,
    key: ChannelFilterKey,
    value: ChannelFilterDecision,
  ) => {
    setConfigDraft(prev => {
      const current = prev.channelFilters[channelId] ?? DEFAULT_CHANNEL_FILTERS
      return {
        ...prev,
        channelFilters: {
          ...prev.channelFilters,
          [channelId]: { ...current, [key]: value },
        },
      }
    })
  }

  const resetChannelFilters = (channelId: string) => {
    setConfigDraft(prev => ({
      ...prev,
      channelFilters: {
        ...prev.channelFilters,
        [channelId]: { ...DEFAULT_CHANNEL_FILTERS },
      },
    }))
  }

  const setManual = (patch: Partial<ManualSettings>) => {
    setConfigDraft(prev => ({
      ...prev,
      manualSettings: { ...prev.manualSettings, ...patch },
    }))
  }

  const updateTpLotRow = (idx: number, patch: Partial<ManualTpLot>) => {
    setConfigDraft(prev => {
      const rows = cloneTpLots(prev.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      rows[idx] = { ...rows[idx], ...patch }
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: rows } }
    })
  }

  const setTpDistributionPercent = (idx: number, raw: string) => {
    const num = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(num)) return
    setConfigDraft(prev => ({
      ...prev,
      manualSettings: {
        ...prev.manualSettings,
        tp_lots: applyTpPercentEdit(prev.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS, idx, num),
      },
    }))
  }

  const setTpRowEnabled = (idx: number, enabled: boolean) => {
    setConfigDraft(prev => {
      const rows = cloneTpLots(prev.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (!enabled) {
        // Keep at least one row enabled so multi-TP distribution always has a target.
        const othersEnabled = rows.filter((r, i) => i !== idx && r.enabled)
        if (othersEnabled.length === 0) return prev
        rows[idx] = { ...rows[idx]!, enabled: false, percent: 0 }
      } else {
        rows[idx] = { ...rows[idx]!, enabled: true }
      }
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const addTpLotRow = () => {
    setConfigDraft(prev => {
      const rows = cloneTpLots(prev.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      rows.push({ label: `TP${rows.length + 1}`, lot: 0.01, percent: 0, enabled: true })
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const removeTpLotRow = (idx: number) => {
    setConfigDraft(prev => {
      const rows = cloneTpLots(prev.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (rows.length <= 1) return prev
      rows.splice(idx, 1)
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const setPredefinedTpPipAt = (idx: number, raw: string) => {
    setConfigDraft(prev => {
      const list = clonePredefinedTpPips(prev.manualSettings.predefined_tp_pips)
      if (idx < 0 || idx >= list.length) return prev
      if (raw === '') {
        list[idx] = 0
      } else {
        const n = Number(raw)
        if (!Number.isFinite(n)) return prev
        list[idx] = n
      }
      return { ...prev, manualSettings: { ...prev.manualSettings, predefined_tp_pips: list } }
    })
  }

  const addPredefinedTpPipRow = () => {
    setConfigDraft(prev => {
      const list = clonePredefinedTpPips(prev.manualSettings.predefined_tp_pips)
      const last = list[list.length - 1] ?? 0
      const next = Number.isFinite(last) && last > 0 ? last + 20 : 20
      list.push(next)
      return { ...prev, manualSettings: { ...prev.manualSettings, predefined_tp_pips: list } }
    })
  }

  const removePredefinedTpPipRow = (idx: number) => {
    setConfigDraft(prev => {
      const list = clonePredefinedTpPips(prev.manualSettings.predefined_tp_pips)
      if (list.length <= 1) return prev
      list.splice(idx, 1)
      return { ...prev, manualSettings: { ...prev.manualSettings, predefined_tp_pips: list } }
    })
  }

  const saveConfigureModal = async () => {
    if (!configAccount || !user) return
    setError('')
    let channelIds = configDraft.channelIds
    let restrictChannels = false
    if (channelOptions.length === 1) {
      channelIds = []
      restrictChannels = false
    } else if (channelOptions.length > 1) {
      if (channelIds.length === 0) {
        setError('Select at least one signal channel.')
        return
      }
      if (channelIds.length === channelOptions.length) {
        channelIds = []
        restrictChannels = false
      } else {
        restrictChannels = true
      }
    }

    setConfigSaving(true)
    const channelMessageFilters: ChannelMessageFiltersMap = {}
    const filterChannelIds = new Set([...channelOptions.map(c => c.id), ...channelIds])
    for (const id of filterChannelIds) {
      channelMessageFilters[id] = configDraft.channelFilters[id] ?? { ...DEFAULT_CHANNEL_FILTERS }
    }
    const { data, error: upErr } = await supabase
      .from('broker_accounts')
      .update({
        copier_mode: AI_CONFIGURATION_ENABLED && configDraft.mode === 'ai' ? 'ai' : 'manual',
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: restrictChannels,
        manual_settings: configDraft.manualSettings,
        channel_message_filters: channelMessageFilters,
      })
      .eq('id', configAccount.id)
      .eq('user_id', user.id)
      .select('*')
      .single()
    setConfigSaving(false)

    if (upErr) { setError(upErr.message); return }

    if (data) {
      const fresh = data as BrokerAccount
      setBrokers(prev => prev.map(b => (b.id === configAccount.id ? fresh : b)))
      setConfigAccount(fresh)
    }
    setConfigSavedAt(Date.now())
  }

  // ── Channel summary helper for cards ───────────────────────────────────

  const getBrokerSignalChannelsLabel = (brokerId: string) => {
    if (channelOptions.length === 0) return 'None selected'
    const oldest = getOldestChannel(channelOptions)
    if (channelOptions.length === 1) {
      const name = oldest?.display_name?.trim()
      return name || 'Signal channel'
    }
    const brokerRow = brokers.find(b => b.id === brokerId)
    const persistedIds = normalizeSignalChannelIds(brokerRow)
    const restricts = brokerRow?.enforce_signal_channel_filter === true
    if (!restricts || persistedIds.length === 0) return 'All signal channels'
    const labels = channelOptions
      .filter(ch => persistedIds.includes(ch.id))
      .map(ch => ch.display_name)
      .filter(Boolean)
    if (labels.length) return labels.join(', ')
    return 'None selected'
  }

  // ── Add account flow ───────────────────────────────────────────────────

  const set = (field: keyof BrokerForm, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }))

  const addBroker = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.account_number.trim() || !form.broker_server.trim() || !form.account_password) {
      setError('Account number, password, and server are required')
      return
    }

    setSaving(true)
    try {
      const { broker, summary } = await metatraderApi.register({
        platform: form.platform,
        server: form.broker_server.trim(),
        login: form.account_number.trim(),
        password: form.account_password,
        label: form.label.trim() || undefined,
      })
      setBrokers(prev => [...prev, broker])
      const registeredType = resolveLinkedAccountType(
        summary?.type,
        resolveMtServerCandidate(broker, broker.broker_server),
      )
      if (registeredType) {
        setBrokerAccountTypes(prev => ({ ...prev, [broker.id]: registeredType }))
      }
      setForm(emptyForm)
      setShowAddBroker(false)
      // If the register endpoint couldn't pull a summary inside its short
      // request window (MT5 sometimes needs a few extra seconds for the
      // session to come up), keep tailing for it client-side so the card
      // is populated without the user having to click Refresh.
      if (broker?.id && (broker.last_balance == null && broker.last_equity == null)) {
        void tailRefreshBrokerSummary(broker.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect account')
    } finally {
      setSaving(false)
    }
  }

  /** Poll AccountSummary for a freshly-registered broker until numbers arrive or we give up. */
  const tailRefreshBrokerSummary = async (brokerId: string) => {
    const delays = [1500, 2500, 4000, 6000, 8000]
    for (const delay of delays) {
      await new Promise(r => setTimeout(r, delay))
      try {
        const { summary, performance_baseline_balance } = await metatraderApi.summary(brokerId)
        if (summary && (summary.balance != null || summary.equity != null || summary.currency)) {
          const patch = {
            last_balance: summary.balance ?? null,
            last_equity: summary.equity ?? null,
            last_currency: summary.currency ?? null,
            last_synced_at: new Date().toISOString(),
            connection_status: 'connected' as const,
            ...(performance_baseline_balance != null && Number.isFinite(Number(performance_baseline_balance))
              ? { performance_baseline_balance: Number(performance_baseline_balance) }
              : {}),
          }
          setBrokers(prev => {
            const match = prev.find(b => b.id === brokerId)
            const accountType = resolveLinkedAccountType(
              summary.type,
              match ? resolveMtServerCandidate(match, match.broker_server) : null,
            )
            if (accountType) {
              setBrokerAccountTypes(types => ({ ...types, [brokerId]: accountType }))
            }
            return prev.map(b => (b.id === brokerId ? { ...b, ...patch } : b))
          })
          setConfigAccount(prev => prev && prev.id === brokerId ? { ...prev, ...patch } : prev)
          return
        }
      } catch {
        // Keep trying — the MT5 server may still be authenticating.
      }
    }
  }

  const confirmDeleteBroker = async () => {
    if (!brokerPendingDelete) return
    setDeleteInProgress(true)
    setError('')
    const id = brokerPendingDelete.id
    try {
      await metatraderApi.remove(id)
      setBrokers(prev => prev.filter(b => b.id !== id))
      setBrokerPendingDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete broker')
    } finally {
      setDeleteInProgress(false)
    }
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    if (!user) return
    setBrokers(prev => prev.map(b => (b.id === id ? { ...b, is_active } : b)))
    setTogglingBrokerId(id)
    const { error: upErr } = await supabase
      .from('broker_accounts')
      .update({ is_active })
      .eq('id', id)
      .eq('user_id', user.id)
    setTogglingBrokerId(null)
    if (upErr) {
      setBrokers(prev => prev.map(b => (b.id === id ? { ...b, is_active: !is_active } : b)))
      setError(upErr.message)
    }
  }

  const tabs = ALL_TABS

  // ── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="px-4 py-4 lg:px-6 lg:py-5 max-w-5xl mx-auto space-y-3">
        {[...Array(2)].map((_, i) => <div key={i} className="h-28 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-100 dark:border-neutral-800 animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="px-4 py-4 lg:px-6 lg:py-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-50">Account &amp; Configuration</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">Connect MetaTrader accounts and tune how each one copies signals.</p>
        </div>
        <Button size="sm" onClick={() => setShowPlatformModal(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add account
        </Button>
      </div>

      {/* ── Broker Accounts ── */}
      <section>

        {showAddBroker && (
          <Card className="mb-3">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-4">
              Connect a new {form.platform} account
            </h3>
            {error && <Alert className="mb-3">{error}</Alert>}
            <form onSubmit={addBroker} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Account label (optional)"
                  placeholder={`e.g. Live ${form.platform}`}
                  value={form.label}
                  onChange={e => set('label', e.target.value)}
                />
                <Select
                  label="Platform"
                  value={form.platform}
                  onChange={e => set('platform', e.target.value as 'MT4' | 'MT5')}
                  options={[
                    { value: 'MT5', label: 'MetaTrader 5 (MT5)' },
                    { value: 'MT4', label: 'MetaTrader 4 (MT4)' },
                  ]}
                />
              </div>

              <BrokerServerSelect
                platform={form.platform}
                value={form.broker_server}
                onChange={(v) => set('broker_server', v)}
                hint="Start typing to filter by broker (IC Markets, Exness, FTMO, …) or server name."
                required
              />

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="MT login"
                  placeholder="Trading account number"
                  value={form.account_number}
                  onChange={e => set('account_number', e.target.value)}
                  required
                />
                <Input
                  label="Password"
                  type="password"
                  placeholder="Trading account password"
                  value={form.account_password}
                  onChange={e => set('account_password', e.target.value)}
                  hint="Sent to MT servers only. Never stored."
                  required
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button type="submit" loading={saving} size="sm">Connect account</Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowAddBroker(false); setForm(emptyForm); setError('') }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        {brokersNeedingReconnect.length > 0 && (
          <Alert variant="warning" className="mb-3">
            {brokersNeedingReconnect.length === 1
              ? 'This account lost its broker connection after the API upgrade. Remove it and connect again with your MT login and password so copying can resume.'
              : `${brokersNeedingReconnect.length} accounts need to be reconnected after the API upgrade. Remove each account and add it again with your MT login and password.`}
          </Alert>
        )}

        {brokers.length === 0 ? (
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-8 text-center">
            <Server className="w-8 h-8 mx-auto mb-2 text-neutral-300 dark:text-neutral-600" />
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No accounts connected yet</p>
            <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-0.5">Add your trading account to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {brokers.map(broker => {
              const statusVariant: 'success' | 'neutral' | 'error' =
                !broker.is_active ? 'neutral'
                : broker.connection_status === 'connected' ? 'success'
                : broker.connection_status === 'error' ? 'error'
                : 'neutral'
              const statusLabel = !broker.is_active ? 'Paused'
                : broker.connection_status === 'connected' ? 'Connected'
                : broker.connection_status === 'error' ? 'Error'
                : 'Disconnected'
              const brokerLabel = broker.broker_name
                || inferBrokerLabelFromServer(broker.broker_server ?? null)
                || broker.broker_server
                || ''
              const channelsLabel = getBrokerSignalChannelsLabel(broker.id)
              const accountType =
                brokerAccountTypes[broker.id]
                ?? resolveLinkedAccountType(undefined, resolveMtServerCandidate(broker, broker.broker_server))
              return (
                <Card key={broker.id} padding="none" className="overflow-hidden">
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-teal-950/60">
                        <PlatformIcon platform={broker.platform} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{broker.label}</h3>
                          <Badge variant={statusVariant} size="sm">{statusLabel}</Badge>
                          <Badge variant="neutral" size="sm">{broker.platform}</Badge>
                          {brokerLabel && (
                            <Badge variant="neutral" size="sm">{brokerLabel}</Badge>
                          )}
                        </div>
                        {broker.broker_server && (
                          <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{broker.broker_server}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex items-center gap-2 pr-1 border-r border-neutral-200 dark:border-neutral-700 mr-1">
                        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 hidden sm:inline">
                          Copy trades
                        </span>
                        <Toggle
                          checked={broker.is_active}
                          onChange={is_active => { void toggleBrokerActive(broker.id, is_active) }}
                          disabled={togglingBrokerId === broker.id}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => openConfigureModal(broker)}
                        className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
                      >
                        Configure
                      </button>
                      <button
                        type="button"
                        onClick={() => { setError(''); setBrokerPendingDelete(broker) }}
                        className="rounded-lg p-1.5 text-neutral-400 dark:text-neutral-500 hover:bg-error-50 dark:hover:bg-error-950/40 hover:text-error-600 dark:hover:text-error-400 transition-colors"
                        aria-label={`Remove ${broker.label}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 lg:grid-cols-6">
                    <AccountDetailCell label="Login" value={broker.account_login || '—'} />
                    <AccountDetailCell
                      label="Account type"
                      value={
                        <span className={accountTypeValueClass(accountType)}>
                          {accountType ?? '—'}
                        </span>
                      }
                      className="border-l border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label="Server"
                      value={broker.broker_server || '—'}
                      className="border-l border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label="Signal channels"
                      value={channelsLabel}
                      className="col-span-2 border-t border-neutral-100 dark:border-neutral-800 lg:col-span-1 lg:border-t-0 lg:border-l"
                    />
                    <AccountDetailCell
                      label="Balance"
                      value={formatBrokerMoney(broker.last_balance, broker.last_currency)}
                      className="border-t border-l border-neutral-100 dark:border-neutral-800 lg:border-t-0"
                    />
                    <AccountDetailCell
                      label="Equity"
                      value={formatBrokerMoney(broker.last_equity, broker.last_currency)}
                      className="border-t border-neutral-100 dark:border-neutral-800 lg:border-l lg:border-t-0"
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <AddAccountModal
        open={showPlatformModal}
        onClose={() => setShowPlatformModal(false)}
        onSelect={(platform) => {
          if (platform !== 'MT4' && platform !== 'MT5') {
            setError(`${platform} integration is coming soon. Pick MT4 or MT5 for now.`)
            setShowPlatformModal(false)
            return
          }
          setForm(prev => ({ ...prev, platform: platform as 'MT4' | 'MT5' }))
          setShowPlatformModal(false)
          setShowAddBroker(true)
        }}
      />

      {brokerPendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-broker-title"
            className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-xl border border-neutral-200 dark:border-neutral-800"
          >
            <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
              <h3 id="delete-broker-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                Remove trading account?
              </h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                This disconnects <span className="font-medium text-neutral-800 dark:text-neutral-100">{brokerPendingDelete.label}</span> from MetatraderAPI and the copier. This cannot be undone.
              </p>
            </div>
            {error && <Alert className="mx-5 mt-3">{error}</Alert>}
            <div className="px-5 py-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={deleteInProgress}
                onClick={() => { if (!deleteInProgress) { setBrokerPendingDelete(null); setError('') } }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={deleteInProgress}
                onClick={() => void confirmDeleteBroker()}
              >
                Remove account
              </Button>
            </div>
          </div>
        </div>
      )}

      {configAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-5xl h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Configure Trading</h3>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
                  {configAccount.label} · {configAccount.platform}
                </p>
              </div>
              <button
                onClick={closeConfigureModal}
                className="px-3 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300"
              >
                Close
              </button>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* Side tabs */}
              <nav className="w-52 border-r border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-3 space-y-0.5 overflow-y-auto">
                {tabs.map(tab => {
                  const Icon = tab.icon
                  const active = tab.id === activeTab
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={clsx(
                        'w-full flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm transition-colors',
                        active
                          ? 'bg-white dark:bg-neutral-900 text-primary-700 shadow-sm border border-primary-100'
                          : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:bg-neutral-900 hover:text-neutral-900 dark:text-neutral-50',
                      )}
                    >
                      <Icon className={clsx('w-4 h-4', active ? 'text-primary-600' : 'text-neutral-400')} />
                      {tab.label}
                    </button>
                  )
                })}
              </nav>

              {/* Tab body column */}
              <div className="flex-1 flex flex-col min-h-0">
                {activeTab === 'mode' && (
                  <div className="px-6 pt-4 bg-white dark:bg-neutral-900 border-b border-neutral-100 dark:border-neutral-800">
                    <div className="flex flex-wrap items-center gap-1">
                      {MANUAL_SUB_TABS.map(sub => {
                        const SubIcon = sub.icon
                        const active = sub.id === activeManualSubTab
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() => setActiveManualSubTab(sub.id)}
                            className={clsx(
                              'flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 -mb-px',
                              active
                                ? 'border-primary-600 text-primary-700'
                                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:text-neutral-100',
                            )}
                          >
                            <SubIcon className={clsx('w-3.5 h-3.5', active ? 'text-primary-600' : 'text-neutral-400')} />
                            {sub.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-6 py-5">
                {error && <Alert className="mb-4">{error}</Alert>}

                {activeTab === 'mode' && (
                  <div className="space-y-5">
                    {/* <div>
                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-2">Configure mode</p>
                      <div className="inline-flex rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-1">
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'ai' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${configDraft.mode === 'ai' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          AI Expert Mode
                        </button>
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'manual' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${configDraft.mode === 'manual' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          Manual
                        </button>
                      </div>
                    </div> */}

                    {AI_CONFIGURATION_ENABLED && configDraft.mode === 'ai' ? (
                      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">AI configuration</p>
                        <p className="text-sm text-neutral-600 dark:text-neutral-400">
                          AI Expert mode behaves like a human expert trader: dynamic lot sizing by balance, range entry handling,
                          TP-based management, and channel instruction interpretation.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <FeatureBullet icon={DollarSign} title="Money management" body="Linear sizing by default; optional margin mode; broker min-lot floor; forex SL-distance refinement." />
                          <FeatureBullet icon={Eye} title="Signal interpretation" body="Handles no-entry, single-entry, range-entry, and delayed TP/SL updates." />
                          <FeatureBullet icon={Activity} title="Trade management" body="Supports partials, break-even, and channel commands like close/secure profits." />
                          <FeatureBullet icon={GitBranch} title="Modification detection" body="Distinguishes new entries from follow-up modification instructions." />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {activeManualSubTab === 'symbol_routing' && (
                          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-4">
                            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Symbol routing</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-1">Symbol Mapping (one per line: FROM=TO)</p>
                                <textarea
                                  className="w-full min-h-[90px] rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm"
                                  placeholder={`GOLD=XAUUSD\nUSOIL=WTIOIL\nBTC=BTCUSD`}
                                  value={symbolMappingText}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    setSymbolMappingText(raw)
                                    const next: Record<string, string> = {}
                                    for (const line of raw.split('\n')) {
                                      const [a, b] = line.split('=').map(s => s.trim())
                                      if (a && b) next[a.toUpperCase()] = b.toUpperCase()
                                    }
                                    setManual({ symbol_mapping: next })
                                  }}
                                />
                                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                                  Examples: <span className="font-mono">GOLD=XAUUSD</span>, <span className="font-mono">USOIL=WTIOIL</span>
                                </p>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <Input label="Symbol Prefix" value={configDraft.manualSettings.symbol_prefix ?? ''} onChange={e => setManual({ symbol_prefix: e.target.value })} />
                                <Input label="Symbol Suffix" value={configDraft.manualSettings.symbol_suffix ?? ''} onChange={e => setManual({ symbol_suffix: e.target.value })} />
                                <div className="col-span-2">
                                  <Input
                                    label="Symbols to Trade"
                                    placeholder="Leave empty for all. Single = override. Multiple = whitelist."
                                    value={configDraft.manualSettings.symbol_to_trade ?? ''}
                                    onChange={e => setManual({ symbol_to_trade: e.target.value })}
                                  />
                                  <p className="text-xs text-slate-500 mt-1">
                                    Empty = trade every signal. One symbol (e.g. <span className="font-mono">XAUUSD</span>) = force every signal to that instrument.
                                    Multiple (e.g. <span className="font-mono">XAUUSD, BTCUSD</span>) = only trade signals matching one of these symbols.
                                  </p>
                                </div>
                                <Input
                                  label="Symbols to Exclude (comma)"
                                  value={(configDraft.manualSettings.symbols_exclude ?? []).join(',')}
                                  onChange={e => setManual({ symbols_exclude: e.target.value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) })}
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {activeManualSubTab === 'risk' && (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select
                                label="Risk Mode"
                                value={configDraft.manualSettings.risk_mode ?? 'fixed_lot'}
                                onChange={e => setManual({ risk_mode: e.target.value as ManualSettings['risk_mode'] })}
                                options={[
                                  { value: 'fixed_lot', label: 'Fixed Lot' },
                                  { value: 'dynamic_balance_percent', label: 'Dynamic (% Balance)' },
                                ]}
                              />
                              {configDraft.manualSettings.risk_mode === 'dynamic_balance_percent' ? (
                                <Input label="% Balance per trade" type="number" value={String(configDraft.manualSettings.dynamic_balance_percent ?? 1)} onChange={e => setManual({ dynamic_balance_percent: Number(e.target.value) })} />
                              ) : (
                                <Input label="Fixed Lot" type="number" value={String(configDraft.manualSettings.fixed_lot ?? 0.01)} onChange={e => setManual({ fixed_lot: Number(e.target.value) })} />
                              )}
                              <Select
                                label="Trade Style"
                                value={configDraft.manualSettings.trade_style ?? 'single'}
                                onChange={e => {
                                  const v = e.target.value as ManualSettings['trade_style']
                                  if (v === 'multi') {
                                    setManual({ trade_style: v, use_signal_entry_price: false })
                                  } else {
                                    setManual({ trade_style: v })
                                  }
                                }}
                                options={[
                                  { value: 'single', label: 'Single Trade' },
                                  { value: 'multi', label: 'Multi Trades' },
                                ]}
                              />
                            </div>

                            {configDraft.manualSettings.trade_style !== 'multi' && (
                              <div className="space-y-4">
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Signal entry execution</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                  <strong>Use Signal Entry Price</strong> applies only in <strong>Single Trade</strong> mode. When enabled, the signal must include an explicit parsed entry (price, zone, @ price, or labels like &quot;Entry Price:&quot;). After any channel delay, the worker compares the <strong>live</strong> quote to that entry: <strong>Buy</strong> fills at market only when ask is at or below the entry; otherwise it places a <strong>buy limit</strong> at the entry. <strong>Sell</strong> is the inverse. The broker take-profit targets the <strong>last</strong> parsed TP when you have several targets, with optional partial closes from your TP ladder. Copier tracks each strict-entry pending so fills sync to your trade list; pendings are cancelled when the basket is flat. Bare &quot;buy now&quot; messages with no entry are skipped.
                                </p>
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Use Signal Entry Price</span>
                                    <Toggle
                                      checked={configDraft.manualSettings.use_signal_entry_price === true}
                                      onChange={v => setManual({ use_signal_entry_price: v })}
                                    />
                                  </div>
                                  {configDraft.manualSettings.use_signal_entry_price && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-2">
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                        <strong>Pip tolerance</strong> is legacy and no longer affects execution; strict entry uses the exact parsed entry price and live bid/ask as above.
                                      </p>
                                      <Input
                                        label="Pip tolerance (legacy)"
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint="Unused for strict entry routing; kept for backward compatibility with saved settings."
                                        value={String(configDraft.manualSettings.signal_entry_pip_tolerance ?? 10)}
                                        onChange={e => setManual({ signal_entry_pip_tolerance: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <div>
                                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
                                        Trailing stop
                                      </p>
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                        Moves stop loss as price moves in your favor after trail start is reached.
                                      </p>
                                    </div>
                                    <Toggle
                                      checked={configDraft.manualSettings.trailing_enabled === true}
                                      onChange={v => setManual({ trailing_enabled: v })}
                                    />
                                  </div>
                                  {configDraft.manualSettings.trailing_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3">
                                      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-2">Trailing settings</p>
                                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <Input
                                          label="Trail Start (pips)"
                                          type="number"
                                          min={0}
                                          step={1}
                                          value={String(configDraft.manualSettings.trailing_start_pips ?? 20)}
                                          onChange={e => setManual({ trailing_start_pips: Math.max(0, Number(e.target.value) || 0) })}
                                        />
                                        <Input
                                          label="Trail Step (pips)"
                                          type="number"
                                          min={0}
                                          step={1}
                                          value={String(configDraft.manualSettings.trailing_step_pips ?? 5)}
                                          onChange={e => setManual({ trailing_step_pips: Math.max(0, Number(e.target.value) || 0) })}
                                        />
                                        <Input
                                          label="Trail Distance (pips)"
                                          type="number"
                                          min={0}
                                          step={1}
                                          value={String(configDraft.manualSettings.trailing_distance_pips ?? 10)}
                                          onChange={e => setManual({ trailing_distance_pips: Math.max(0, Number(e.target.value) || 0) })}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {configDraft.manualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                  <strong>Multi Trades</strong> splits your fixed lot into many smaller orders
                                  (e.g. <span className="font-mono">1.0 lot @ 5%/leg = 20 trades of 0.05</span>).
                                  Legs are distributed across the signal's TPs using the percent rows below.
                                  If the per-leg size falls below the broker's symbol minimum, the planner
                                  falls back to a single full-size trade and logs the reason.
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <Input
                                    label="Per-leg size (% of fixed lot)"
                                    type="number"
                                    min={0.1}
                                    max={100}
                                    step={0.5}
                                    value={String(configDraft.manualSettings.multi_trade_leg_percent ?? 5)}
                                    onChange={e => setManual({ multi_trade_leg_percent: Number(e.target.value) })}
                                  />
                                  <div>
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-1">Total Open Trades</p>
                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-50">
                                      {multiTradePreview.fallsBackSingle
                                        ? '1 (split not possible at 0.01 min / 0.01 step preview)'
                                        : multiTradePreview.immediate != null && multiTradePreview.pending != null
                                          ? `${multiTradePreview.totalOrders} (${multiTradePreview.immediate} instant + ${multiTradePreview.pending} for layering)`
                                          : multiTradePreview.totalOrders}
                                    </div>
                                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                                      Estimated from Fixed Lot and per-leg %. Live execution uses the symbol&apos;s min lot and step (may differ slightly). Capped at 500 orders per signal.
                                      {' '}Telegram-reported lots on each signal do not resize multi-trade baskets—they always split your Fixed Lot.
                                      {configDraft.manualSettings.risk_mode === 'dynamic_balance_percent' && (
                                        <> With Dynamic (% Balance) risk, the resolved lot at runtime can differ from Fixed Lot.</>
                                      )}
                                      {configDraft.manualSettings.range_trading
                                        && multiTradePreview.effectiveDistancePips != null
                                        && (multiTradePreview.pending ?? 0) > 0
                                        && Math.abs(multiTradePreview.effectiveDistancePips - (Number(configDraft.manualSettings.range_distance_pips ?? 0) || 0)) >= 1 && (
                                        <> Ladder span = {multiTradePreview.pending} × {Number(configDraft.manualSettings.range_step_pips ?? 0) || 0}p = {multiTradePreview.effectiveDistancePips}p (configured distance {Number(configDraft.manualSettings.range_distance_pips ?? 0) || 0}p is advisory).</>
                                      )}
                                      {configDraft.manualSettings.close_worse_entries && (multiTradePreview.immediate ?? 0) > 0 && (
                                        <> {multiTradePreview.immediate} instant leg{(multiTradePreview.immediate ?? 0) === 1 ? '' : 's'} close at +{Number(configDraft.manualSettings.close_worse_entries_pips ?? 20) || 0}p from anchor.</>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {configDraft.manualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Range Layering</p>
                                  <Toggle
                                    checked={configDraft.manualSettings.range_trading === true}
                                    onChange={v => setManual({ range_trading: v })}
                                  />
                                </div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                  Reserve a share of the planned legs as pending Limit orders stepped away from the
                                  live anchor by a fixed pip interval (averaging-down). When the signal carries no
                                  entry price, the worker fetches a live <strong>/Quote</strong> bid/ask and anchors
                                  the ladder there. Stop-loss and TP distribution mirror the immediate legs. If
                                  <strong> distance &divide; step </strong> caps the count, the effective pending
                                  total is reduced.
                                </p>
                                {configDraft.manualSettings.range_trading && (
                                  <>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <Input
                                        label="Reserved lot (% of total)"
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={1}
                                        placeholder="50"
                                        hint="Share of total legs reserved as pendings."
                                        value={String(configDraft.manualSettings.range_percent ?? 50)}
                                        onChange={e => setManual({ range_percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                                      />
                                      <Input
                                        label="Step (pips per layering)"
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="10"
                                        hint={
                                          formatPipHint(Number(configDraft.manualSettings.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips) || 0)
                                          ?? 'Pips between pendings.'
                                        }
                                        value={String(configDraft.manualSettings.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips)}
                                        onChange={e => setManual({ range_step_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                      <Input
                                        label="Range distance (pips from entry)"
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="100"
                                        hint={
                                          formatPipHint(Number(configDraft.manualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0)
                                          ?? "Advisory target span. Actual ladder reach = pending count × step (Total Open Trades is not capped by this)."
                                        }
                                        value={String(configDraft.manualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips)}
                                        onChange={e => setManual({ range_distance_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                    </div>

                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-3 space-y-3">
                                      <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Close worse entries</p>
                                        <Toggle
                                          checked={configDraft.manualSettings.close_worse_entries === true}
                                          onChange={v => setManual({ close_worse_entries: v })}
                                        />
                                      </div>
                                      <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                        When price reaches +X pips from the signal entry (anchor), the worker
                                        auto-closes instant legs via /OrderClose.
                                        A channel message such as &quot;Close worse entries&quot; closes every open
                                        leg whose entry is within X pips of the live price at that moment
                                        (e.g. instant fills near the signal, not deep layers). No broker TP
                                        is set on CWE legs — only the SL rides on the broker.
                                      </p>
                                      {configDraft.manualSettings.close_worse_entries && (
                                        <Input
                                          label="Close profits from worse entry (pips)"
                                          type="number"
                                          min={1}
                                          step={1}
                                          placeholder="30"
                                          hint={
                                            formatPipHint(Number(configDraft.manualSettings.close_worse_entries_pips ?? 30) || 0)
                                            ?? 'Distance from live price (instruction) or anchor + X pips (auto).'
                                          }
                                          value={String(configDraft.manualSettings.close_worse_entries_pips ?? 30)}
                                          onChange={e => setManual({ close_worse_entries_pips: Math.max(1, Number(e.target.value) || 1) })}
                                        />
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                          </div>
                        )}

                        {activeManualSubTab === 'stops' && (
                          <div className="space-y-4">
                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">TP distribution (% of legs)</p>
                                <Button variant="ghost" size="sm" onClick={addTpLotRow}>Add TP</Button>
                              </div>
                              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                Set each enabled TP&apos;s share manually. The total across enabled rows cannot
                                exceed 100% — any input is capped to the remaining budget. Disabled rows are
                                pinned at 0%.
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                <strong>Multi-trade:</strong> distributes the planned legs across TPs by these
                                percentages (e.g. 50/30/20 of 20 legs &rarr; 10/6/4 at TP1/TP2/TP3).
                                <br />
                                <strong>Single-trade:</strong> the order rides to the <strong>last enabled TP</strong>{' '}
                                at the broker; the worker auto-partial-closes the configured percentage at every
                                earlier TP (e.g. 50/30/20 on a 1.0 lot &rarr; close 0.50 at TP1, 0.30 at TP2,
                                remaining 0.20 closes at TP3 via the broker).
                              </p>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-neutral-600 dark:text-neutral-400">
                                  Enabled total:{' '}
                                  <strong className={clsx('font-semibold', tpLegPercentTotal === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                                    {tpLegPercentTotal}%
                                  </strong>{' '}
                                  / 100%
                                </span>
                                {tpLegPercentTotal !== 100 && (
                                  <span className="text-amber-600">
                                    {tpLegPercentTotal < 100
                                      ? `${100 - tpLegPercentTotal}% unallocated`
                                      : 'Over 100% (capped on next edit)'}
                                  </span>
                                )}
                              </div>
                              <div className="space-y-2">
                                {(configDraft.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).map((row, idx) => {
                                  const tpRows = configDraft.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
                                  const othersSum = tpRows.reduce(
                                    (s, r, i) => (i !== idx && r.enabled ? s + (Number(r.percent) || 0) : s),
                                    0,
                                  )
                                  const rowBudget = Math.max(0, 100 - othersSum)
                                  return (
                                    <div key={`${row.label}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                                      <input
                                        className="col-span-4 rounded-md border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-sm"
                                        value={row.label}
                                        onChange={e => updateTpLotRow(idx, { label: e.target.value })}
                                      />
                                      <input
                                        className="col-span-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-sm disabled:bg-neutral-100 dark:bg-neutral-800 disabled:text-neutral-400"
                                        type="number"
                                        min={0}
                                        max={rowBudget}
                                        step={1}
                                        disabled={!row.enabled}
                                        title={row.enabled ? `Max ${rowBudget}% available for this row` : 'Enable the row to edit its share'}
                                        value={String(row.percent ?? 0)}
                                        onChange={e => setTpDistributionPercent(idx, e.target.value)}
                                      />
                                      <span className="col-span-1 text-xs text-neutral-500 dark:text-neutral-400 text-center">%</span>
                                      <label className="col-span-2 text-xs text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          checked={row.enabled}
                                          onChange={e => setTpRowEnabled(idx, e.target.checked)}
                                        />
                                        Enabled
                                      </label>
                                      <Button className="col-span-2" variant="ghost" size="sm" onClick={() => removeTpLotRow(idx)}>Remove</Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>

                          </div>
                        )}

                        {activeManualSubTab === 'management' && (() => {
                          const ms = configDraft.manualSettings
                          const autoMgmtEnabled = (ms.move_sl_to_entry_after_mode ?? 'none') !== 'none'
                          const triggerMode = ms.move_sl_to_entry_after_mode ?? 'pips'
                          const beType = ms.move_sl_to_entry_type ?? 'sl_only'
                          const tpRows = ms.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
                          const tpSelectOptions = tpRows
                            .map((row, i) => ({
                              value: String(i + 1),
                              label: row.label?.trim() || `TP${i + 1}`,
                            }))
                            .filter((_, i) => tpRows[i]?.enabled !== false)
                          const tpOptions = tpSelectOptions.length > 0
                            ? tpSelectOptions
                            : [{ value: '1', label: 'TP1' }, { value: '2', label: 'TP2' }, { value: '3', label: 'TP3' }]

                          return (
                          <div className="space-y-4">
                            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                              <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                <div>
                                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Auto-management</p>
                                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                    Automatically move stop loss to breakeven when your trigger condition is met.
                                  </p>
                                </div>
                                <Toggle
                                  checked={autoMgmtEnabled}
                                  onChange={v => {
                                    if (v) {
                                      const prev = ms.move_sl_to_entry_after_mode
                                      setManual({
                                        move_sl_to_entry_after_mode:
                                          prev && prev !== 'none' ? prev : 'pips',
                                      })
                                    } else {
                                      setManual({ move_sl_to_entry_after_mode: 'none' })
                                    }
                                  }}
                                />
                              </div>

                              {autoMgmtEnabled && (
                                <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-4">
                                  <div className="space-y-3">
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Move SL to breakeven after</p>
                                    <Select
                                      label="Trigger"
                                      value={triggerMode === 'none' ? 'pips' : triggerMode}
                                      onChange={e => setManual({
                                        move_sl_to_entry_after_mode: e.target.value as ManualSettings['move_sl_to_entry_after_mode'],
                                      })}
                                      options={[
                                        { value: 'pips', label: 'Pips' },
                                        { value: 'rr', label: 'RR' },
                                        { value: 'money', label: 'Money' },
                                        { value: 'tp_hit', label: 'TP' },
                                      ]}
                                    />

                                    {triggerMode === 'pips' && (
                                      <Input
                                        label="Pip movement"
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint="How many pips in profit before stop loss moves to breakeven."
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'rr' && (
                                      <Input
                                        label="Risk:Reward ratio"
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        hint="RR reached before stop loss moves to breakeven (e.g. 1 = 1:1)."
                                        value={String(ms.move_sl_to_entry_after_value ?? 1)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'money' && (
                                      <Input
                                        label="Profit ($)"
                                        type="number"
                                        min={0}
                                        step={0.01}
                                        hint="Unrealized profit in account currency before stop loss moves to breakeven."
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'tp_hit' && (
                                      <div className="space-y-1.5">
                                        <Select
                                          label="Take profit"
                                          value={String(ms.move_sl_to_entry_tp_index ?? 1)}
                                          onChange={e => setManual({
                                            move_sl_to_entry_tp_index: Math.max(1, Number(e.target.value) || 1),
                                          })}
                                          options={tpOptions}
                                        />
                                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                          Which take-profit level must be hit before stop loss moves to breakeven.
                                        </p>
                                      </div>
                                    )}

                                    <Input
                                      label="Breakeven offset (pips)"
                                      type="number"
                                      min={0}
                                      step={1}
                                      hint="Pips beyond entry when placing breakeven stop (locks in a small profit)."
                                      value={String(ms.breakeven_offset_pips ?? 10)}
                                      onChange={e => setManual({
                                        breakeven_offset_pips: Math.max(0, Number(e.target.value) || 0),
                                      })}
                                    />
                                  </div>

                                  <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
                                    <div className="px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
                                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Breakeven type</p>
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                        What happens when the trigger condition is met.
                                      </p>
                                    </div>
                                    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setManual({ move_sl_to_entry_type: 'sl_only' })}
                                        className={clsx(
                                          'rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                                          beType === 'sl_only'
                                            ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                            : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600',
                                        )}
                                      >
                                        <span className="font-medium">Move Only</span>
                                        <span className="block text-xs mt-0.5 opacity-80">
                                          Move stop loss to breakeven only.
                                        </span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setManual({ move_sl_to_entry_type: 'sl_and_close_half' })}
                                        className={clsx(
                                          'rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                                          beType === 'sl_and_close_half'
                                            ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                            : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600',
                                        )}
                                      >
                                        <span className="font-medium">Move SL and Close Half</span>
                                        <span className="block text-xs mt-0.5 opacity-80">
                                          Move stop loss to breakeven and close half the position.
                                        </span>
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                          )
                        })()}

                        {activeManualSubTab === 'filters' && (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select label="Time Filter" value={configDraft.manualSettings.time_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ time_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                              {configDraft.manualSettings.time_filter_enabled && (
                                <Input label="Start Time" type="time" value={configDraft.manualSettings.trade_start_time ?? '00:00'} onChange={e => setManual({ trade_start_time: e.target.value })} />
                              )}
                              {configDraft.manualSettings.time_filter_enabled && (
                                <Input label="End Time" type="time" value={configDraft.manualSettings.trade_end_time ?? '23:59'} onChange={e => setManual({ trade_end_time: e.target.value })} />
                              )}
                              <Select label="Days Filter" value={configDraft.manualSettings.days_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ days_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                            </div>
                            {configDraft.manualSettings.days_filter_enabled && (
                              <div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-1">Days of the week</p>
                                <div className="flex flex-wrap gap-3">
                                  {[
                                    { label: 'Sunday', value: 0 },
                                    { label: 'Monday', value: 1 },
                                    { label: 'Tuesday', value: 2 },
                                    { label: 'Wednesday', value: 3 },
                                    { label: 'Thursday', value: 4 },
                                    { label: 'Friday', value: 5 },
                                    { label: 'Saturday', value: 6 },
                                  ].map((d) => (
                                    <label key={d.value} className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={(configDraft.manualSettings.trade_days ?? [1, 2, 3, 4, 5]).includes(d.value)}
                                        onChange={(e) => {
                                          const prev = configDraft.manualSettings.trade_days ?? [1, 2, 3, 4, 5]
                                          const next = e.target.checked ? [...new Set([...prev, d.value])] : prev.filter((x) => x !== d.value)
                                          setManual({ trade_days: next })
                                        }}
                                      />
                                      {d.label}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select label="Allow High Impact News" value={configDraft.manualSettings.allow_high_impact_news ? 'yes' : 'no'} onChange={e => setManual({ allow_high_impact_news: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                              {configDraft.manualSettings.allow_high_impact_news && (
                                <Input label="Close Before News (min)" type="number" value={String(configDraft.manualSettings.close_before_news_minutes ?? 10)} onChange={e => setManual({ close_before_news_minutes: Number(e.target.value) })} />
                              )}
                              {configDraft.manualSettings.allow_high_impact_news && (
                                <Input label="Resume After News (min)" type="number" value={String(configDraft.manualSettings.resume_after_news_minutes ?? 10)} onChange={e => setManual({ resume_after_news_minutes: Number(e.target.value) })} />
                              )}
                            </div>
                          </div>
                        )}

                        {activeManualSubTab === 'strategy' && (
                          <div className="space-y-4">
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">
                              Strategy controls how the copier reacts to signals and applies your own SL/TP
                              templates. Trailing stop (Single Trade) is under <strong>Risk &amp; Entry</strong>. Auto breakeven triggers live under <strong>Management</strong>.
                            </p>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Signal behavior</p>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <Select
                                  label="Reverse Signal"
                                  value={configDraft.manualSettings.reverse_signal ? 'yes' : 'no'}
                                  onChange={e => {
                                    const v = e.target.value === 'yes'
                                    if (v && !reverseSignalPlannerGateSettingsOk(configDraft.manualSettings)) return
                                    setManual({ reverse_signal: v })
                                  }}
                                  options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]}
                                />
                                <Select
                                  label="Add New Trade to Existing"
                                  value={configDraft.manualSettings.add_new_trades_to_existing ? 'yes' : 'no'}
                                  onChange={e => setManual({ add_new_trades_to_existing: e.target.value === 'yes' })}
                                  options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
                                />
                                <Select
                                  label="Close on Opposite Signal"
                                  value={configDraft.manualSettings.close_on_opposite_signal ? 'yes' : 'no'}
                                  onChange={e => setManual({ close_on_opposite_signal: e.target.value === 'yes' })}
                                  options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]}
                                />
                              </div>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                <strong>Reverse:</strong> flips buy/sell only when the signal has an entry price or zone{' '}
                                <em>and</em> both predefined SL and TP are enabled with positive pip values — so mirrored risk uses your template, not the channel&apos;s stops.
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                <strong>Close on opposite:</strong> in manual mode, a new channel buy/sell closes any open trades on the same symbol facing the opposite way (channel direction, before reverse), cancels their virtual range pendings, then the new plan runs.
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                <strong>Add to existing:</strong> follow-up on the same side refreshes every **open leg** that belongs to the same original signal (same basket), in **fill order** (oldest leg first), using the planner&apos;s **multi-trade TP distribution** (each leg gets the SL/TP of the matching immediate order from your TP lot percentage rows). Range virtual pendings for that basket are cancelled and re-inserted under the **parent** signal. Reply-thread or **4h** time window still applies. Single-trade partial-TP rows are only re-created when the basket is a single leg.
                              </p>
                            </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Predefined SL &amp; TP</p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                Override the signal&apos;s own stops/targets with your own fixed pip values
                                or risk-reward multiples. Useful when channels post inconsistent levels.
                                Precedence: predefined pip overrides, then channel SL/TP (after pip conversion), then R:R-for-SL, then R:R-for-TPs.
                              </p>
                              <div className="space-y-3">
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Use Predefined SL Pips</span>
                                    <Toggle
                                      checked={configDraft.manualSettings.use_predefined_sl_pips === true}
                                      onChange={v => setManual({ use_predefined_sl_pips: v })}
                                    />
                                  </div>
                                  {configDraft.manualSettings.use_predefined_sl_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <Input
                                        label="Predefined SL Pips"
                                        type="number"
                                        hint={formatPipHint(Number(configDraft.manualSettings.predefined_sl_pips ?? 30) || 0) ?? undefined}
                                        value={String(configDraft.manualSettings.predefined_sl_pips ?? 30)}
                                        onChange={e => setManual({ predefined_sl_pips: Number(e.target.value) })}
                                      />
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Use Predefined TPs</span>
                                    <Toggle
                                      checked={configDraft.manualSettings.use_predefined_tp_pips === true}
                                      onChange={v => {
                                        if (!v) {
                                          setManual({ use_predefined_tp_pips: false })
                                          return
                                        }
                                        setConfigDraft(prev => {
                                          let list = prev.manualSettings.predefined_tp_pips
                                          if (!Array.isArray(list) || list.length === 0) {
                                            list = [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          } else {
                                            const filtered = list.map(n => Number(n)).filter(Number.isFinite)
                                            list = filtered.length > 0 ? filtered : [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          }
                                          return {
                                            ...prev,
                                            manualSettings: {
                                              ...prev.manualSettings,
                                              use_predefined_tp_pips: true,
                                              predefined_tp_pips: list,
                                            },
                                          }
                                        })
                                      }}
                                    />
                                  </div>
                                  {configDraft.manualSettings.use_predefined_tp_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-3">
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                          Distance from entry to each take-profit, in pips (TP1, TP2, …). Same pattern as{' '}
                                          <strong>Stops &amp; Targets</strong> — add or remove rows as needed.
                                        </p>
                                        <Button variant="ghost" size="sm" className="shrink-0 self-start sm:self-auto" onClick={addPredefinedTpPipRow}>
                                          Add TP
                                        </Button>
                                      </div>
                                      <div className="space-y-2">
                                        {clonePredefinedTpPips(configDraft.manualSettings.predefined_tp_pips).map((pips, idx) => (
                                          <div key={`predef-tp-${idx}`} className="grid grid-cols-12 gap-2 items-end">
                                            <div className="col-span-10">
                                              <Input
                                                label={`TP${idx + 1} (pips)`}
                                                type="number"
                                                min={0}
                                                step={1}
                                                hint={formatPipHint(Number(pips) || 0) ?? undefined}
                                                value={String(pips)}
                                                onChange={e => setPredefinedTpPipAt(idx, e.target.value)}
                                              />
                                            </div>
                                            <Button
                                              className="col-span-2"
                                              variant="ghost"
                                              size="sm"
                                              onClick={() => removePredefinedTpPipRow(idx)}
                                            >
                                              Remove
                                            </Button>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Enable R:R for SL</span>
                                    <Toggle
                                      checked={configDraft.manualSettings.rr_for_sl_enabled === true}
                                      onChange={v => setManual({ rr_for_sl_enabled: v })}
                                    />
                                  </div>
                                  {configDraft.manualSettings.rr_for_sl_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <Input
                                        label="SL R:R"
                                        type="number"
                                        hint="When SL is omitted but TP exists: SL distance = (distance from entry to TP1) ÷ this ratio. Predefined pip SL (if on) and channel SL override this."
                                        value={String(configDraft.manualSettings.rr_for_sl ?? 1)}
                                        onChange={e => setManual({ rr_for_sl: Number(e.target.value) })}
                                      />
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Enable R:R for TPs</span>
                                    <Toggle
                                      checked={configDraft.manualSettings.rr_for_tps_enabled === true}
                                      onChange={v => setManual({ rr_for_tps_enabled: v })}
                                    />
                                  </div>
                                  {configDraft.manualSettings.rr_for_tps_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <Input
                                        label="TP R:R values (comma)"
                                        hint="When TPs are omitted but SL exists: each TP = entry ± (entry→SL distance) × each ratio. Predefined pip TPs (if on) and channel TPs override this."
                                        value={(configDraft.manualSettings.rr_for_tps ?? []).join(',')}
                                        onChange={e => setManual({ rr_for_tps: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Pending orders</p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                Applied to broker Limit/Stop sends and worker virtual range legs. 
                                {/* <code className="text-[11px]">WORKER_BROKER_PENDING_EXPIRY_SWEEP=true</code> on the worker to cancel stale TSCopier broker pendings past this TTL when order open time is available from the API. */}
                              </p>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <Input
                                  label="Pending Expiry (hours 1-24)"
                                  type="number"
                                  min={1}
                                  max={24}
                                  step={1}
                                  hint="Use 1–24 hours. Values are clamped in the planner; 0 in stored settings means no expiry (not recommended from this panel)."
                                  value={String(configDraft.manualSettings.pending_expiry_hours ?? 1)}
                                  onChange={e => {
                                    const n = Number(e.target.value)
                                    const v = Number.isFinite(n) ? Math.max(1, Math.min(24, Math.floor(n))) : 1
                                    setManual({ pending_expiry_hours: v })
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'channels' && (
                  <div className="space-y-5">
                    {/* Section A: pick which Telegram channels feed this broker. */}
                    <div className="space-y-3">
                      {channelOptions.length === 0 ? (
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          No connected channels found. <Link to="/copier-engine" className="text-primary-600 underline">Connect channels here</Link>.
                        </p>
                      ) : channelOptions.length === 1 ? (
                        <p className="text-sm text-neutral-600 dark:text-neutral-400">
                          One Telegram channel is connected — this broker copies from it automatically.
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Signal channels</p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">{configDraft.channelIds.length} selected</p>
                          </div>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            All channels selected (default) copies every connected Telegram channel. Uncheck one or more to restrict this broker.
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {channelOptions.map(channel => (
                              <label key={channel.id} className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                                <input
                                  type="checkbox"
                                  checked={configDraft.channelIds.includes(channel.id)}
                                  onChange={() => toggleDraftChannel(channel.id)}
                                />
                                <div className="min-w-0">
                                  <p className="text-sm text-neutral-800 dark:text-neutral-100 truncate">{channel.display_name}</p>
                                  {channel.channel_username && (
                                    <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">@{channel.channel_username}</p>
                                  )}
                                </div>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Section B: per-channel keyword filters. Always shown
                        when at least one channel is connected, regardless of
                        the single-channel auto-select copy above. */}
                    {channelOptions.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Channel keyword filters</p>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            {(() => {
                              const ids = channelOptions.length === 1
                                ? [channelOptions[0]!.id]
                                : configDraft.channelIds
                              const total = ids.reduce((sum, id) => {
                                const f = configDraft.channelFilters[id] ?? DEFAULT_CHANNEL_FILTERS
                                return sum + CHANNEL_FILTER_CATEGORIES.reduce(
                                  (n, c) => n + (f[c.key] === 'ignore' ? 1 : 0), 0,
                                )
                              }, 0)
                              return total === 0 ? 'All categories allowed' : `${total} ignored across all channels`
                            })()}
                          </p>
                        </div>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          Mark a category as Ignore to skip matching instructions from that channel on this
                          broker (trades keep running). Ignoring Close full position also blocks generic
                          &quot;close&quot; and &quot;close all&quot; messages.
                        </p>

                        {(() => {
                          // For a 1-channel account the picker is hidden, but the user still wants filter
                          // controls — render the lone channel directly. Otherwise honour the broker's
                          // channelIds selection so an unchecked channel disappears from this list.
                          const visibleIds = channelOptions.length === 1
                            ? [channelOptions[0]!.id]
                            : configDraft.channelIds
                          if (visibleIds.length === 0) {
                            return (
                              <p className="text-xs text-neutral-400 italic">
                                Select at least one channel above to configure its filters.
                              </p>
                            )
                          }
                          const byId = new Map(channelOptions.map(c => [c.id, c]))
                          return (
                            <div className="space-y-2">
                              {visibleIds.map((id, idx) => {
                                const channel = byId.get(id)
                                if (!channel) return null
                                const filters = normalizeChannelFilters(
                                  configDraft.channelFilters[id] ?? DEFAULT_CHANNEL_FILTERS,
                                )
                                return (
                                  <ChannelFiltersCard
                                    key={id}
                                    channel={channel}
                                    filters={filters}
                                    onChange={(key, value) => setChannelFilter(id, key, value)}
                                    onReset={() => resetChannelFilters(id)}
                                    defaultOpen={idx === 0 && visibleIds.length === 1}
                                  />
                                )
                              })}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )}

                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end gap-3">
              {configSavedAt != null && (
                <span className="text-xs text-success-600 transition-opacity">Saved</span>
              )}
              <Button variant="ghost" onClick={closeConfigureModal} disabled={configSaving}>Cancel</Button>
              <Button loading={configSaving} onClick={() => void saveConfigureModal()}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab subcomponents ────────────────────────────────────────────────────

function FeatureBullet({ icon: Icon, title, body }: { icon: typeof DollarSign; title: string; body: string }) {
  return (
    <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-800 p-3">
      <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-primary-600" />
        {title}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{body}</p>
    </div>
  )
}

/**
 * Collapsible filter card for a single Telegram channel. Header always shows
 * the channel name, optional `@username`, and a badge indicating how many of
 * the nine categories are currently set to "ignore". Body reveals the full
 * Allow / Ignore grid.
 */
function ChannelFiltersCard({
  channel,
  filters,
  onChange,
  onReset,
  defaultOpen = false,
}: {
  channel: ChannelOption
  filters: ChannelFilters
  onChange: (key: ChannelFilterKey, value: ChannelFilterDecision) => void
  onReset: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ignoredCount = CHANNEL_FILTER_CATEGORIES.reduce(
    (n, c) => n + (filters[c.key] === 'ignore' ? 1 : 0),
    0,
  )
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <button
        type="button"
        className="w-full flex items-center justify-between p-3 text-left"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channel.display_name || 'Unnamed channel'}</p>
          {channel.channel_username && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">@{channel.channel_username}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {ignoredCount > 0 && (
            <span className="text-[10px] font-medium uppercase tracking-wide rounded-full px-2 py-0.5 bg-amber-50 text-amber-700">
              {ignoredCount} ignored
            </span>
          )}
          <ChevronDown className={clsx('w-4 h-4 text-neutral-500 dark:text-neutral-400 transition-transform', open && 'rotate-180')} />
        </div>
      </button>
      {open && (
        <div className="p-3 border-t border-neutral-100 dark:border-neutral-800 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {CHANNEL_FILTER_CATEGORIES.map(cat => (
              <CategoryRow
                key={cat.key}
                label={cat.label}
                example={cat.example}
                value={filters[cat.key] ?? 'allow'}
                onChange={v => onChange(cat.key, v)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              Ignored categories drop matching messages from this channel before the worker runs them.
            </p>
            <button
              type="button"
              className="text-xs text-primary-600 hover:text-primary-700 hover:underline"
              onClick={onReset}
              disabled={ignoredCount === 0}
            >
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CategoryRow({
  label,
  example,
  value,
  onChange,
}: {
  label: string
  example: string
  value: ChannelFilterDecision
  onChange: (v: ChannelFilterDecision) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-neutral-800 dark:text-neutral-100 truncate">{label}</p>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">{example}</p>
      </div>
      <div className="inline-flex items-center rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-0.5 shrink-0">
        <button
          type="button"
          className={clsx(
            'px-2.5 py-1 text-xs rounded',
            value === 'allow' ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300',
          )}
          onClick={() => onChange('allow')}
          aria-pressed={value === 'allow'}
        >
          Allow
        </button>
        <button
          type="button"
          className={clsx(
            'px-2.5 py-1 text-xs rounded',
            value === 'ignore' ? 'bg-amber-50 text-amber-700 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300',
          )}
          onClick={() => onChange('ignore')}
          aria-pressed={value === 'ignore'}
        >
          Ignore
        </button>
      </div>
    </div>
  )
}