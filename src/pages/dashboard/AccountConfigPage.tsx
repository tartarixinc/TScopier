import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus, Trash2, Server, Activity, GitBranch, Eye, DollarSign,
  SlidersHorizontal, Radio, Target, TrendingUp, Filter, Wallet,
  ArrowLeftRight,
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
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { BrokerServerSelect } from '../../components/ui/BrokerServerSelect'
import { metatraderApi } from '../../lib/metatraderapi'
import { inferBrokerLabelFromServer } from '../../lib/brokerFromServer'
import { estimateMultiTradeOrderCount } from '../../lib/estimateMultiTradeOrders'
import { pipCalculator, pipValueForLots, type PipQuote } from '../../lib/pipCalculator'
import { classifySymbol } from '../../lib/pipMath'
import type { BrokerAccount, ManualSettings, ManualTpLot } from '../../types/database'

interface ChannelOption {
  id: string
  display_name: string
  channel_username: string
  is_active: boolean
  created_at: string
}

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

interface AccountConfigDraft {
  mode: 'ai' | 'manual'
  channelIds: string[]
  manualSettings: ManualSettings
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
  range_step_pips: 10,
  range_distance_pips: 100,
  close_worse_entries: false,
  close_worse_entries_pips: 30,
  close_worse_extra_pendings: 0,
  reverse_signal: false,
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
  const rangeStepPips = Math.max(0, readNumber('range_step_pips', DEFAULT_MANUAL_SETTINGS.range_step_pips ?? 10))
  const rangeDistancePips = Math.max(0, readNumber('range_distance_pips', DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 100))
  const closeWorseEntries = (j as Record<string, unknown>).close_worse_entries === true
  const closeWorseEntriesPips = Math.max(0, readNumber('close_worse_entries_pips', DEFAULT_MANUAL_SETTINGS.close_worse_entries_pips ?? 30))
  const closeWorseExtraPendings = Math.max(0, Math.floor(readNumber('close_worse_extra_pendings', DEFAULT_MANUAL_SETTINGS.close_worse_extra_pendings ?? 0)))

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
    close_worse_extra_pendings: closeWorseExtraPendings,
    symbol_mapping: Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
    symbols_exclude: Array.isArray(j.symbols_exclude) ? j.symbols_exclude.map(String).map(s => s.toUpperCase()) : [],
    tp_lots: tpFinal,
    predefined_tp_pips: Array.isArray(j.predefined_tp_pips) ? j.predefined_tp_pips.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.predefined_tp_pips,
    rr_for_tps: Array.isArray(j.rr_for_tps) ? j.rr_for_tps.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.rr_for_tps,
    trade_days: Array.isArray(j.trade_days) ? j.trade_days.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.trade_days,
  }
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

type ConfigTabId = 'mode' | 'channels'
type ManualSubTabId = 'symbol_routing' | 'risk' | 'stops' | 'trailing' | 'filters'

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
  { id: 'mode', label: 'Mode', icon: SlidersHorizontal },
  { id: 'channels', label: 'Channels', icon: Radio },
]

const MANUAL_SUB_TABS: ManualSubTabDef[] = [
  { id: 'symbol_routing', label: 'Symbol Routing', icon: ArrowLeftRight },
  { id: 'risk', label: 'Risk & Sizing', icon: Wallet },
  { id: 'stops', label: 'Stops & Targets', icon: Target },
  { id: 'trailing', label: 'Trailing', icon: TrendingUp },
  { id: 'filters', label: 'Filters', icon: Filter },
]

export function AccountConfigPage() {
  const { user } = useAuth()
  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([])
  const [configAccount, setConfigAccount] = useState<BrokerAccount | null>(null)
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({
    mode: 'ai',
    channelIds: [],
    manualSettings: { ...DEFAULT_MANUAL_SETTINGS },
  })
  const [activeTab, setActiveTab] = useState<ConfigTabId>('mode')
  const [activeManualSubTab, setActiveManualSubTab] = useState<ManualSubTabId>('symbol_routing')
  const [symbolMappingText, setSymbolMappingText] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showAddBroker, setShowAddBroker] = useState(false)
  const [form, setForm] = useState<BrokerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)

  const multiTradePreview = useMemo(() => {
    const ms = configDraft.manualSettings
    const manualLot = Number(ms.fixed_lot ?? 0.01) || 0.01
    const legPct = Number(ms.multi_trade_leg_percent ?? 5) || 5
    const range = ms.range_trading
      ? {
          enabled: true,
          percent: Number(ms.range_percent ?? 50) || 0,
          stepPips: Number(ms.range_step_pips ?? 2) || 0,
          distancePips: Number(ms.range_distance_pips ?? 20) || 0,
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

  // Keep close_worse_extra_pendings within the live pending count so the UI
  // can't show a stale value larger than what the planner will actually use.
  useEffect(() => {
    if (!configDraft.manualSettings.range_trading) return
    if (!configDraft.manualSettings.close_worse_entries) return
    const max = multiTradePreview.pending ?? 0
    const current = Math.max(0, Math.floor(Number(configDraft.manualSettings.close_worse_extra_pendings ?? 0) || 0))
    if (current > max) {
      setConfigDraft(prev => ({
        ...prev,
        manualSettings: { ...prev.manualSettings, close_worse_extra_pendings: max },
      }))
    }
  }, [
    multiTradePreview.pending,
    configDraft.manualSettings.range_trading,
    configDraft.manualSettings.close_worse_entries,
    configDraft.manualSettings.close_worse_extra_pendings,
  ])

  useEffect(() => {
    if (!user) return
    void loadData()
  }, [user])

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
    setBrokers((brokersRes.data ?? []) as BrokerAccount[])
    setChannelOptions((channelsRes.data ?? []) as ChannelOption[])
    setLoading(false)
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
      mode: fresh.copier_mode === 'manual' ? 'manual' : 'ai',
      channelIds,
      manualSettings,
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
    setConfigDraft(prev => ({
      ...prev,
      channelIds: prev.channelIds.includes(channelId)
        ? prev.channelIds.filter(id => id !== channelId)
        : [...prev.channelIds, channelId],
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
    const { data, error: upErr } = await supabase
      .from('broker_accounts')
      .update({
        copier_mode: configDraft.mode === 'manual' ? 'manual' : 'ai',
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: restrictChannels,
        manual_settings: configDraft.mode === 'manual' ? configDraft.manualSettings : (configAccount.manual_settings ?? {}),
      })
      .eq('id', configAccount.id)
      .eq('user_id', user.id)
      .select('*')
      .single()
    setConfigSaving(false)

    if (upErr) { setError(upErr.message); return }

    if (data) {
      setBrokers(prev => prev.map(b => (b.id === configAccount.id ? (data as BrokerAccount) : b)))
    }
    closeConfigureModal()
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
      const { broker } = await metatraderApi.register({
        platform: form.platform,
        server: form.broker_server.trim(),
        login: form.account_number.trim(),
        password: form.account_password,
        label: form.label.trim() || undefined,
      })
      setBrokers(prev => [...prev, broker])
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
        const { summary } = await metatraderApi.summary(brokerId)
        if (summary && (summary.balance != null || summary.equity != null || summary.currency)) {
          const patch = {
            last_balance: summary.balance ?? null,
            last_equity: summary.equity ?? null,
            last_currency: summary.currency ?? null,
            last_synced_at: new Date().toISOString(),
            connection_status: 'connected' as const,
          }
          setBrokers(prev => prev.map(b => b.id === brokerId ? { ...b, ...patch } : b))
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

  const tabs = ALL_TABS

  // ── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-4">
        {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-white rounded-xl border border-neutral-100 animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">Account &amp; Configuration</h1>
        <p className="text-sm text-neutral-500 mt-0.5">Connect MetaTrader accounts and tune how each one copies signals.</p>
      </div>

      {/* ── Broker Accounts ── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900">Trading Accounts</h2>
            <p className="text-xs text-neutral-400 mt-0.5">Connect your broker accounts via MetatraderAPI.</p>
          </div>
          <Button size="sm" onClick={() => setShowPlatformModal(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add account
          </Button>
        </div>

        {showAddBroker && (
          <Card className="mb-3">
            <h3 className="text-sm font-semibold text-neutral-900 mb-4">
              Connect a new {form.platform} account
            </h3>
            {error && (
              <div className="mb-3 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">{error}</div>
            )}
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
                  hint="Sent to MetatraderAPI only. Never stored."
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

        {brokers.length === 0 ? (
          <div className="bg-white rounded-xl border border-dashed border-neutral-200 py-10 text-center">
            <Server className="w-8 h-8 mx-auto mb-2 text-neutral-300" />
            <p className="text-sm text-neutral-400">No accounts connected yet</p>
            <p className="text-xs text-neutral-300 mt-0.5">Add your trading account to get started</p>
          </div>
        ) : (
          <div className="space-y-2">
            {brokers.map(broker => {
              const statusVariant: 'success' | 'neutral' | 'error' =
                broker.connection_status === 'connected' ? 'success'
                : broker.connection_status === 'error' ? 'error'
                : broker.is_active ? 'success' : 'neutral'
              const statusLabel = broker.connection_status === 'connected' ? 'Connected'
                : broker.connection_status === 'error' ? 'Error'
                : broker.is_active ? 'Active' : 'Paused'
              const brokerLabel = broker.broker_name
                || inferBrokerLabelFromServer(broker.broker_server ?? null)
                || broker.broker_server
                || ''
              return (
                <Card key={broker.id} padding="sm">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <PlatformIcon platform={broker.platform} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-neutral-900">{broker.label}</p>
                        <Badge variant={statusVariant} size="sm">{statusLabel}</Badge>
                        <Badge variant="neutral" size="sm">{broker.platform}</Badge>
                        {brokerLabel && (
                          <Badge variant="neutral" size="sm">{brokerLabel}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        <span className="font-medium text-neutral-700">Login:</span> {broker.account_login || '—'}
                        {broker.broker_server && (<><span className="mx-1.5">·</span><span className="font-medium text-neutral-700">Server:</span> {broker.broker_server}</>)}
                      </p>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        <span className="font-medium text-neutral-700">Signal Channels:</span> {getBrokerSignalChannelsLabel(broker.id)}
                      </p>
                      {(broker.last_balance != null || broker.last_equity != null) && (
                        <p className="text-xs text-neutral-500 mt-0.5">
                          {broker.last_balance != null && (
                            <span>Balance: {broker.last_balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {broker.last_currency ?? ''}</span>
                          )}
                          {broker.last_balance != null && broker.last_equity != null && ' · '}
                          {broker.last_equity != null && (
                            <span>Equity: {broker.last_equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {broker.last_currency ?? ''}</span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => openConfigureModal(broker)}
                        className="px-3 py-1.5 text-xs font-medium border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors"
                      >
                        Configure
                      </button>
                      <button
                        type="button"
                        onClick={() => { setError(''); setBrokerPendingDelete(broker) }}
                        className="p-1.5 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
                        aria-label={`Remove ${broker.label}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
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
            className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-neutral-200"
          >
            <div className="px-5 py-4 border-b border-neutral-100">
              <h3 id="delete-broker-title" className="text-base font-semibold text-neutral-900">
                Remove trading account?
              </h3>
              <p className="text-sm text-neutral-500 mt-1">
                This disconnects <span className="font-medium text-neutral-800">{brokerPendingDelete.label}</span> from MetatraderAPI and the copier. This cannot be undone.
              </p>
            </div>
            {error && (
              <div className="mx-5 mt-3 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">
                {error}
              </div>
            )}
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
          <div className="w-full max-w-5xl h-[88vh] flex flex-col rounded-2xl bg-white shadow-xl border border-neutral-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900">Configure Account</h3>
                <p className="text-sm text-neutral-500 mt-0.5">
                  {configAccount.label} · {configAccount.platform}
                </p>
              </div>
              <button
                onClick={closeConfigureModal}
                className="px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-700"
              >
                Close
              </button>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* Side tabs */}
              <nav className="w-52 border-r border-neutral-100 bg-neutral-50 p-3 space-y-0.5 overflow-y-auto">
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
                          ? 'bg-white text-primary-700 shadow-sm border border-primary-100'
                          : 'text-neutral-600 hover:bg-white hover:text-neutral-900',
                      )}
                    >
                      <Icon className={clsx('w-4 h-4', active ? 'text-primary-600' : 'text-neutral-400')} />
                      {tab.label}
                    </button>
                  )
                })}
              </nav>

              {/* Tab body */}
              <div className="flex-1 overflow-y-auto px-6 py-5">
                {error && (
                  <div className="mb-4 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">{error}</div>
                )}

                {activeTab === 'mode' && (
                  <div className="space-y-5">
                    <div>
                      <p className="text-sm font-medium text-neutral-800 mb-2">Configure mode</p>
                      <div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-1">
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'ai' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${configDraft.mode === 'ai' ? 'bg-primary-600 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
                        >
                          AI Expert Mode
                        </button>
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'manual' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${configDraft.mode === 'manual' ? 'bg-primary-600 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
                        >
                          Manual
                        </button>
                      </div>
                    </div>

                    {configDraft.mode === 'ai' ? (
                      <div className="rounded-xl border border-neutral-200 p-4 space-y-3">
                        <p className="text-sm font-semibold text-neutral-900">AI configuration</p>
                        <p className="text-sm text-neutral-600">
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
                        <p className="text-sm font-semibold text-neutral-900">Manual</p>
                        <div className="flex flex-wrap items-center gap-1 border-b border-neutral-100">
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
                                    : 'border-transparent text-neutral-500 hover:text-neutral-800',
                                )}
                              >
                                <SubIcon className={clsx('w-3.5 h-3.5', active ? 'text-primary-600' : 'text-neutral-400')} />
                                {sub.label}
                              </button>
                            )
                          })}
                        </div>

                        {activeManualSubTab === 'symbol_routing' && (
                          <div className="rounded-xl border border-neutral-200 p-4 space-y-4">
                            <p className="text-sm font-semibold text-neutral-900">Symbol routing</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <p className="text-xs text-neutral-600 mb-1">Symbol Mapping (one per line: FROM=TO)</p>
                                <textarea
                                  className="w-full min-h-[90px] rounded-md border border-neutral-200 px-3 py-2 text-sm"
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
                                <p className="mt-1 text-[11px] text-neutral-500">
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
                                onChange={e => setManual({ trade_style: e.target.value as ManualSettings['trade_style'] })}
                                options={[
                                  { value: 'single', label: 'Single Trade' },
                                  { value: 'multi', label: 'Multi Trades' },
                                ]}
                              />
                            </div>

                            {configDraft.manualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 p-3 space-y-3">
                                <p className="text-xs text-neutral-600">
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
                                    <p className="text-sm font-medium text-neutral-800 mb-1">Total Open Trades</p>
                                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-mono text-neutral-900">
                                      {multiTradePreview.fallsBackSingle
                                        ? '1 (split not possible at 0.01 min / 0.01 step preview)'
                                        : multiTradePreview.immediate != null && multiTradePreview.pending != null
                                          ? `${multiTradePreview.totalOrders} (${multiTradePreview.immediate} instant + ${multiTradePreview.pending} for layering)`
                                          : multiTradePreview.totalOrders}
                                    </div>
                                    <p className="text-xs text-neutral-500 mt-1">
                                      Estimated from Fixed Lot and per-leg %. Live execution uses the symbol's min lot and step (may differ slightly). Capped at 500 orders per signal.
                                      {configDraft.manualSettings.risk_mode === 'dynamic_balance_percent' && (
                                        <> With Dynamic (% Balance) risk, the resolved lot at runtime can differ from Fixed Lot.</>
                                      )}
                                      {configDraft.manualSettings.range_trading
                                        && multiTradePreview.effectiveDistancePips != null
                                        && (multiTradePreview.pending ?? 0) > 0
                                        && Math.abs(multiTradePreview.effectiveDistancePips - (Number(configDraft.manualSettings.range_distance_pips ?? 0) || 0)) >= 1 && (
                                        <> Ladder span = {multiTradePreview.pending} × {Number(configDraft.manualSettings.range_step_pips ?? 0) || 0}p = {multiTradePreview.effectiveDistancePips}p (configured distance {Number(configDraft.manualSettings.range_distance_pips ?? 0) || 0}p is advisory).</>
                                      )}
                                      {configDraft.manualSettings.range_trading && configDraft.manualSettings.close_worse_entries && (multiTradePreview.immediate ?? 0) + Math.min(
                                        Number(configDraft.manualSettings.close_worse_extra_pendings ?? 0) || 0,
                                        multiTradePreview.pending ?? 0,
                                      ) > 0 && (
                                        <> {(multiTradePreview.immediate ?? 0) + Math.min(
                                          Number(configDraft.manualSettings.close_worse_extra_pendings ?? 0) || 0,
                                          multiTradePreview.pending ?? 0,
                                        )} legs close at +{Number(configDraft.manualSettings.close_worse_entries_pips ?? 20) || 0}p.</>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {configDraft.manualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-medium text-neutral-800">Range Layering</p>
                                  <Toggle
                                    checked={configDraft.manualSettings.range_trading === true}
                                    onChange={v => setManual({ range_trading: v })}
                                  />
                                </div>
                                <p className="text-xs text-neutral-600">
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
                                          formatPipHint(Number(configDraft.manualSettings.range_step_pips ?? 10) || 0)
                                          ?? 'Pips between pendings.'
                                        }
                                        value={String(configDraft.manualSettings.range_step_pips ?? 10)}
                                        onChange={e => setManual({ range_step_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                      <Input
                                        label="Range distance (pips from entry)"
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="100"
                                        hint={
                                          formatPipHint(Number(configDraft.manualSettings.range_distance_pips ?? 100) || 0)
                                          ?? "Advisory target span. Actual ladder reach = pending count × step (Total Open Trades is not capped by this)."
                                        }
                                        value={String(configDraft.manualSettings.range_distance_pips ?? 100)}
                                        onChange={e => setManual({ range_distance_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                    </div>

                                    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 space-y-3">
                                      <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-neutral-800">Close worse entries</p>
                                        <Toggle
                                          checked={configDraft.manualSettings.close_worse_entries === true}
                                          onChange={v => setManual({ close_worse_entries: v })}
                                        />
                                      </div>
                                      <p className="text-xs text-neutral-600">
                                        When price moves +X pips beyond the worse (earliest) entry, the
                                        worker auto-closes all immediates plus the shallowest layers
                                        via /OrderClose. No broker-side TP is set on these legs (only the
                                        SL rides) — this avoids "Invalid stops" rejections when the basket
                                        is already in profit. Deeper layers keep their percent-row TPs
                                        and ride for the bigger targets.
                                      </p>
                                      {configDraft.manualSettings.close_worse_entries && (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                          <Input
                                            label="Close profits from worse entry (pips)"
                                            type="number"
                                            min={1}
                                            step={1}
                                            placeholder="30"
                                            hint={
                                              formatPipHint(Number(configDraft.manualSettings.close_worse_entries_pips ?? 30) || 0)
                                              ?? 'Pip profit from the worse entry. 30 pips ≈ $3.00 on XAUUSD, 0.0030 on EURUSD.'
                                            }
                                            value={String(configDraft.manualSettings.close_worse_entries_pips ?? 30)}
                                            onChange={e => setManual({ close_worse_entries_pips: Math.max(1, Number(e.target.value) || 1) })}
                                          />
                                          <Input
                                            label="Also close shallowest layers"
                                            type="number"
                                            min={0}
                                            max={multiTradePreview.pending ?? 0}
                                            step={1}
                                            placeholder="0"
                                            hint={`Max ${multiTradePreview.pending ?? 0} (current pending count). 0 = immediates only.`}
                                            value={String(configDraft.manualSettings.close_worse_extra_pendings ?? 0)}
                                            onChange={e => {
                                              const max = multiTradePreview.pending ?? 0
                                              const v = Math.max(0, Math.floor(Number(e.target.value) || 0))
                                              setManual({ close_worse_extra_pendings: Math.min(max, v) })
                                            }}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select label="Reverse Signal" value={configDraft.manualSettings.reverse_signal ? 'yes' : 'no'} onChange={e => setManual({ reverse_signal: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                            </div>
                          </div>
                        )}

                        {activeManualSubTab === 'stops' && (
                          <div className="space-y-4">
                            <div className="rounded-lg border border-neutral-200 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-neutral-800">TP distribution (% of legs)</p>
                                <Button variant="ghost" size="sm" onClick={addTpLotRow}>Add TP</Button>
                              </div>
                              <p className="text-xs text-neutral-600">
                                Set each enabled TP&apos;s share manually. The total across enabled rows cannot
                                exceed 100% — any input is capped to the remaining budget. Disabled rows are
                                pinned at 0%.
                              </p>
                              <p className="text-xs text-neutral-500">
                                <strong>Multi-trade:</strong> distributes the planned legs across TPs by these
                                percentages (e.g. 50/30/20 of 20 legs &rarr; 10/6/4 at TP1/TP2/TP3).
                                <br />
                                <strong>Single-trade:</strong> the order rides to the <strong>last enabled TP</strong>{' '}
                                at the broker; the worker auto-partial-closes the configured percentage at every
                                earlier TP (e.g. 50/30/20 on a 1.0 lot &rarr; close 0.50 at TP1, 0.30 at TP2,
                                remaining 0.20 closes at TP3 via the broker).
                              </p>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-neutral-600">
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
                                        className="col-span-4 rounded-md border border-neutral-200 px-2 py-1.5 text-sm"
                                        value={row.label}
                                        onChange={e => updateTpLotRow(idx, { label: e.target.value })}
                                      />
                                      <input
                                        className="col-span-3 rounded-md border border-neutral-200 px-2 py-1.5 text-sm disabled:bg-neutral-100 disabled:text-neutral-400"
                                        type="number"
                                        min={0}
                                        max={rowBudget}
                                        step={1}
                                        disabled={!row.enabled}
                                        title={row.enabled ? `Max ${rowBudget}% available for this row` : 'Enable the row to edit its share'}
                                        value={String(row.percent ?? 0)}
                                        onChange={e => setTpDistributionPercent(idx, e.target.value)}
                                      />
                                      <span className="col-span-1 text-xs text-neutral-500 text-center">%</span>
                                      <label className="col-span-2 text-xs text-neutral-700 flex items-center gap-2">
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

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.use_predefined_sl_pips === true} onChange={e => setManual({ use_predefined_sl_pips: e.target.checked })} />Use Predefined SL Pips</label>
                              {configDraft.manualSettings.use_predefined_sl_pips && (
                                <Input
                                  label="Predefined SL Pips"
                                  type="number"
                                  hint={formatPipHint(Number(configDraft.manualSettings.predefined_sl_pips ?? 30) || 0) ?? undefined}
                                  value={String(configDraft.manualSettings.predefined_sl_pips ?? 30)}
                                  onChange={e => setManual({ predefined_sl_pips: Number(e.target.value) })}
                                />
                              )}
                              <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.use_predefined_tp_pips === true} onChange={e => setManual({ use_predefined_tp_pips: e.target.checked })} />Use Predefined TPs</label>
                              {configDraft.manualSettings.use_predefined_tp_pips && (
                                <Input
                                  label="Predefined TP Pips (comma)"
                                  hint={(() => {
                                    // For the comma-separated TP input, show the per-pip rate and let
                                    // the user multiply themselves; otherwise the hint would have to
                                    // pick one TP. Falls back to undefined when no symbol is set.
                                    const h = formatPipHint(0)
                                    return h ?? undefined
                                  })()}
                                  value={(configDraft.manualSettings.predefined_tp_pips ?? []).join(',')}
                                  onChange={e => setManual({ predefined_tp_pips: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })}
                                />
                              )}
                              <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.rr_for_sl_enabled === true} onChange={e => setManual({ rr_for_sl_enabled: e.target.checked })} />Enable R:R for SL</label>
                              {configDraft.manualSettings.rr_for_sl_enabled && (
                                <Input label="SL R:R" type="number" value={String(configDraft.manualSettings.rr_for_sl ?? 1)} onChange={e => setManual({ rr_for_sl: Number(e.target.value) })} />
                              )}
                              <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.rr_for_tps_enabled === true} onChange={e => setManual({ rr_for_tps_enabled: e.target.checked })} />Enable R:R for TPs</label>
                              {configDraft.manualSettings.rr_for_tps_enabled && (
                                <Input label="TP R:R values (comma)" value={(configDraft.manualSettings.rr_for_tps ?? []).join(',')} onChange={e => setManual({ rr_for_tps: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })} />
                              )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Input label="Pending Expiry (hours 1-24)" type="number" value={String(configDraft.manualSettings.pending_expiry_hours ?? 1)} onChange={e => setManual({ pending_expiry_hours: Number(e.target.value) })} />
                              <Select label="Add New Trades to Existing" value={configDraft.manualSettings.add_new_trades_to_existing ? 'yes' : 'no'} onChange={e => setManual({ add_new_trades_to_existing: e.target.value === 'yes' })} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
                              <Select label="Close on Opposite Signal" value={configDraft.manualSettings.close_on_opposite_signal ? 'yes' : 'no'} onChange={e => setManual({ close_on_opposite_signal: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select label="Move SL to Entry After" value={configDraft.manualSettings.move_sl_to_entry_after_mode ?? 'none'} onChange={e => setManual({ move_sl_to_entry_after_mode: e.target.value as ManualSettings['move_sl_to_entry_after_mode'] })} options={[{ value: 'none', label: 'None' }, { value: 'pips', label: 'Pips' }, { value: 'rr', label: 'RR' }, { value: 'money', label: 'Money' }, { value: 'tp_hit', label: 'TP Hit' }]} />
                              {configDraft.manualSettings.move_sl_to_entry_after_mode !== 'none' && (
                                <Input label="Move SL Trigger Value" type="number" value={String(configDraft.manualSettings.move_sl_to_entry_after_value ?? 10)} onChange={e => setManual({ move_sl_to_entry_after_value: Number(e.target.value) })} />
                              )}
                              {configDraft.manualSettings.move_sl_to_entry_after_mode !== 'none' && (
                                <Select label="Move SL Type" value={configDraft.manualSettings.move_sl_to_entry_type ?? 'sl_only'} onChange={e => setManual({ move_sl_to_entry_type: e.target.value as ManualSettings['move_sl_to_entry_type'] })} options={[{ value: 'sl_only', label: 'Move SL only' }, { value: 'sl_and_close_half', label: 'Move SL and close half' }]} />
                              )}
                              <Input label="Breakeven Offset (pips)" type="number" value={String(configDraft.manualSettings.breakeven_offset_pips ?? 10)} onChange={e => setManual({ breakeven_offset_pips: Number(e.target.value) })} />
                              <Input label="Partial Close (%)" type="number" value={String(configDraft.manualSettings.partial_close_percent ?? 25)} onChange={e => setManual({ partial_close_percent: Number(e.target.value) })} />
                              <Input label="Half Close (%)" type="number" value={String(configDraft.manualSettings.half_close_percent ?? 50)} onChange={e => setManual({ half_close_percent: Number(e.target.value) })} />
                            </div>
                          </div>
                        )}

                        {activeManualSubTab === 'trailing' && (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                              <Select label="Trailing SL" value={configDraft.manualSettings.trailing_enabled ? 'yes' : 'no'} onChange={e => setManual({ trailing_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                              <Input label="Trail Start (pips)" type="number" value={String(configDraft.manualSettings.trailing_start_pips ?? 20)} onChange={e => setManual({ trailing_start_pips: Number(e.target.value) })} />
                              <Input label="Trail Step (pips)" type="number" value={String(configDraft.manualSettings.trailing_step_pips ?? 5)} onChange={e => setManual({ trailing_step_pips: Number(e.target.value) })} />
                              <Input label="Trail Distance (pips)" type="number" value={String(configDraft.manualSettings.trailing_distance_pips ?? 10)} onChange={e => setManual({ trailing_distance_pips: Number(e.target.value) })} />
                            </div>
                          </div>
                        )}

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
                                <p className="text-xs text-neutral-600 mb-1">Days of the week</p>
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
                                    <label key={d.value} className="text-sm text-neutral-700 flex items-center gap-2">
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
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'channels' && (
                  <div className="space-y-3">
                    {channelOptions.length === 0 ? (
                      <p className="text-sm text-neutral-500">
                        No connected channels found. <Link to="/copier-engine" className="text-primary-600 underline">Connect channels here</Link>.
                      </p>
                    ) : channelOptions.length === 1 ? (
                      <p className="text-sm text-neutral-600">
                        One Telegram channel is connected — this broker copies from it automatically.
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold text-neutral-900">Signal channels</p>
                          <p className="text-xs text-neutral-500">{configDraft.channelIds.length} selected</p>
                        </div>
                        <p className="text-xs text-neutral-500">
                          All channels selected (default) copies every connected Telegram channel. Uncheck one or more to restrict this broker.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {channelOptions.map(channel => (
                            <label key={channel.id} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 cursor-pointer hover:bg-neutral-50">
                              <input
                                type="checkbox"
                                checked={configDraft.channelIds.includes(channel.id)}
                                onChange={() => toggleDraftChannel(channel.id)}
                              />
                              <div className="min-w-0">
                                <p className="text-sm text-neutral-800 truncate">{channel.display_name}</p>
                                {channel.channel_username && (
                                  <p className="text-xs text-neutral-500 truncate">@{channel.channel_username}</p>
                                )}
                              </div>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

              </div>
            </div>

            <div className="px-6 py-4 border-t border-neutral-100 flex items-center justify-end gap-2">
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
    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
      <p className="text-xs font-medium text-neutral-700 mb-1 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-primary-600" />
        {title}
      </p>
      <p className="text-xs text-neutral-500">{body}</p>
    </div>
  )
}

