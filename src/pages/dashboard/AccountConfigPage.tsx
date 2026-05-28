import { useEffect, useState, useMemo, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Plus, Trash2, Server, Activity, GitBranch, Eye, DollarSign, RefreshCw,
  SlidersHorizontal, Radio, Target, Filter, Wallet, Link2,
  ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, Search, Settings2, Bookmark, Pencil, ScrollText, AlertTriangle,
  Infinity,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Toggle } from '../../components/ui/Toggle'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Alert } from '../../components/ui/Alert'
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { MtCompanyServerPicker } from '../../components/ui/MtCompanyServerPicker'
import { formatLocalCalendarDay } from '../../lib/dayStartBalance'
import { metatraderApi } from '../../lib/metatraderapi'
import { isLegacyBrokerLink } from '../../lib/brokerLink'
import { brokerCanReconnect, brokerConnectionBadgeVariant, brokerConnectionStatusLabel } from '../../lib/brokerReconnect'
import {
  brokerConnectErrorLabelsFromI18n,
  brokerConnectErrorText,
  brokerReconnectBannerText,
  type BrokerConnectErrorKind,
} from '../../lib/brokerConnectError'
import { BROKER_ACCOUNT_CLIENT_SELECT } from '../../lib/brokerAccountSelect'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { normalizeManualSettingsForPlan } from '../../lib/planLimits'
import { UpgradePrompt } from '../../components/billing/UpgradePrompt'
import {
  inferBrokerLabelFromServer,
  resolveLinkedAccountType,
  resolveMtServerCandidate,
  type LinkedAccountType,
} from '../../lib/brokerFromServer'
import { estimateMultiTradeOrderCount } from '../../lib/estimateMultiTradeOrders'
import { pipCalculator, pipValueForLots, type PipQuote } from '../../lib/pipCalculator'
import { classifySymbol } from '../../lib/pipMath'
import { pipsToPriceOffset, signalPipPrice } from '../../lib/signalPip'
import { formatMoneyWithCode } from '../../lib/currency'
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
import { isAutoManagementEnabled } from '../../lib/autoManagementDisplay'
import {
  buildChannelTradingConfigsFromDraft,
  buildDefaultChannelTradingConfig,
  normalizeChannelTradingConfigsMap,
} from '../../lib/channelTradingConfig'
import {
  listTradingPresets,
  presetToChannelConfigDraft,
  upsertTradingPreset,
  type ChannelTradingPreset,
} from '../../lib/tradingPresets'
import {
  connectChannelToBroker,
  getBrokerDisplayLabel,
} from '../../lib/brokerChannelLink'
import { DEFAULT_MANUAL_SETTINGS, DEFAULT_MANUAL_TP_LOTS } from '../../lib/defaultManualSettings'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import {
  describeAutoManagementRuleI18n,
  describePredefinedStopsOverrideI18n,
  formatPipHintI18n,
  getChannelFilterCategories,
} from './configureModalI18n'

interface ChannelOption {
  id: string
  display_name: string
  channel_username: string
  is_active: boolean
  created_at: string
}

/** Survives route unmount so sidebar navigation does not flash the loading skeleton. */
const channelOptionsCache = new Map<string, ChannelOption[]>()

interface BrokerForm {
  label: string
  platform: 'MT4' | 'MT5'
  account_number: string
  account_password: string
  broker_server: string
  remember_password: boolean
}

const emptyForm: BrokerForm = {
  label: '',
  platform: 'MT5',
  account_number: '',
  account_password: '',
  broker_server: '',
  remember_password: false,
}

const BROKER_PAGE_SIZE = 10

function resolveBrokerFilterLabel(broker: BrokerAccount): string {
  return (
    broker.broker_name
    || inferBrokerLabelFromServer(broker.broker_server ?? null)
    || broker.broker_server
    || '—'
  )
}

function brokerMatchesSearch(broker: BrokerAccount, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    broker.label,
    broker.account_login,
    broker.broker_server,
    broker.broker_name,
    broker.platform,
    resolveBrokerFilterLabel(broker),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

function normalizeSignalChannelIds(b: BrokerAccount | undefined): string[] {
  const raw = b?.signal_channel_ids
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return []
}

/** When false, the configure modal only shows manual settings (AI tab hidden). */
const AI_CONFIGURATION_ENABLED = false

interface ChannelConfigDraft {
  mode: 'ai' | 'manual'
  manualSettings: ManualSettings
  channelFilters: ChannelFilters
}

interface AccountConfigDraft {
  channelIds: string[]
  selectedChannelId: string | null
  channelConfigs: Record<string, ChannelConfigDraft>
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
    news_trading_enabled: (() => {
      if (j.news_trading_enabled === true) return true
      if (j.news_trading_enabled === false) return false
      return j.allow_high_impact_news === true
    })(),
    news_avoid_impacts: (() => {
      const raw = j.news_avoid_impacts
      if (Array.isArray(raw)) {
        const valid = raw.filter(
          (i): i is 'high' | 'medium' | 'low' => i === 'high' || i === 'medium' || i === 'low',
        )
        if (valid.length) return valid
      }
      return DEFAULT_MANUAL_SETTINGS.news_avoid_impacts ?? ['high']
    })(),
    allow_high_impact_news: (() => {
      if (j.news_trading_enabled === true) return true
      if (j.news_trading_enabled === false) return false
      return j.allow_high_impact_news === true
    })(),
    close_before_news_minutes: Math.max(
      0,
      Math.min(24 * 60, Math.floor(readNumber('close_before_news_minutes', DEFAULT_MANUAL_SETTINGS.close_before_news_minutes ?? 30))),
    ),
    resume_after_news_minutes: Math.max(
      0,
      Math.min(24 * 60, Math.floor(readNumber('resume_after_news_minutes', DEFAULT_MANUAL_SETTINGS.resume_after_news_minutes ?? 15))),
    ),
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
  return formatMoneyWithCode(value, currency?.trim() || undefined)
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

type ManualSubTabId = 'channel_instructions' | 'symbol_routing' | 'risk' | 'stops' | 'management' | 'filters'

interface ManualSubTabDef {
  id: ManualSubTabId
  label: string
  icon: typeof SlidersHorizontal
}

function defaultChannelConfigDraft(): ChannelConfigDraft {
  return {
    mode: 'manual',
    manualSettings: normalizeManualSettings(buildDefaultChannelTradingConfig().manual_settings),
    channelFilters: { ...DEFAULT_CHANNEL_FILTERS },
  }
}

function channelConfigDraftSignature(draft: ChannelConfigDraft): string {
  return JSON.stringify({
    mode: draft.mode,
    manualSettings: draft.manualSettings,
    channelFilters: normalizeChannelFilters(draft.channelFilters),
  })
}

function isChannelConfigDefault(draft: ChannelConfigDraft): boolean {
  return channelConfigDraftSignature(draft) === channelConfigDraftSignature(defaultChannelConfigDraft())
}

function buildChannelConfigDraftFromBroker(
  broker: BrokerAccount,
  channelIds: string[],
): AccountConfigDraft {
  const storedConfigs = normalizeChannelTradingConfigsMap(broker.channel_trading_configs)
  const persistedFilters = normalizeChannelMessageFiltersMap(broker.channel_message_filters)
  const channelConfigs: Record<string, ChannelConfigDraft> = {}
  const legacyManual = normalizeManualSettings(broker.manual_settings)
  const legacyMode = AI_CONFIGURATION_ENABLED && broker.copier_mode !== 'manual' ? 'ai' : 'manual'

  for (const id of channelIds) {
    const stored = storedConfigs[id]
    channelConfigs[id] = {
      mode: stored?.copier_mode === 'ai' ? 'ai' : stored?.copier_mode === 'manual' ? 'manual' : legacyMode,
      manualSettings: stored?.manual_settings
        ? normalizeManualSettings(stored.manual_settings)
        : legacyManual,
      channelFilters: normalizeChannelFilters(persistedFilters[id] ?? DEFAULT_CHANNEL_FILTERS),
    }
  }

  return {
    channelIds,
    selectedChannelId: channelIds[0] ?? null,
    channelConfigs,
  }
}

function formatLinkedAccountTypeLabel(
  type: LinkedAccountType | undefined,
  labels: { demo: string; live: string },
): string {
  if (!type) return '—'
  if (type === 'Demo') return labels.demo
  if (type === 'Live') return labels.live
  return type
}

export function AccountConfigPage() {
  const t = useT()
  const navigate = useNavigate()
  const cm = t.accountConfig.configureModal
  const bl = t.accountConfig.brokerList

  const manualSubTabs = useMemo<ManualSubTabDef[]>(
    () => [
      { id: 'channel_instructions', label: cm.manualSubTabs.channelInstructions, icon: ScrollText },
      { id: 'symbol_routing', label: cm.manualSubTabs.symbolRouting, icon: ArrowLeftRight },
      { id: 'risk', label: cm.manualSubTabs.risk, icon: Wallet },
      { id: 'stops', label: cm.manualSubTabs.stops, icon: Target },
      { id: 'management', label: cm.manualSubTabs.management, icon: Settings2 },
      { id: 'filters', label: cm.manualSubTabs.filters, icon: Filter },
    ],
    [
      cm.manualSubTabs.channelInstructions,
      cm.manualSubTabs.symbolRouting,
      cm.manualSubTabs.risk,
      cm.manualSubTabs.stops,
      cm.manualSubTabs.management,
      cm.manualSubTabs.filters,
    ],
  )

  const channelFilterCategories = useMemo(
    () => getChannelFilterCategories(cm),
    [cm],
  )
  const { user } = useAuth()
  const userId = user?.id ?? null
  const {
    brokers,
    loading: brokersLoading,
    loadError: brokersLoadError,
    upsertBroker,
    replaceBroker,
    removeBroker,
    patchBroker,
    setBrokers,
    toggleBrokerActive: toggleBrokerActiveInStore,
    reconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting: isBrokerReconnecting,
    setReconnectErrorHandler,
    clearStoredCredentials,
  } = useBrokerAccounts()
  const {
    subscription,
    hasActiveSubscription,
    canAddBroker,
    canUseFeature: canUsePlanFeature,
    limits,
    isAdmin,
    usage,
    usageLoading,
  } = useSubscription()
  const pw = t.pricing.paywall
  const connectErrorLabels = useMemo(() => brokerConnectErrorLabelsFromI18n(bl), [bl])
  const reconnectBannerText = useMemo(
    () => brokerReconnectBannerText(brokersNeedingReconnect, {
      ...connectErrorLabels,
      droppedOne: bl.reconnectDroppedOne,
      droppedMany: bl.reconnectDroppedMany,
    }),
    [brokersNeedingReconnect, connectErrorLabels, bl.reconnectDroppedOne, bl.reconnectDroppedMany],
  )
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>(() =>
    userId ? (channelOptionsCache.get(userId) ?? []) : [],
  )
  const [configAccount, setConfigAccount] = useState<BrokerAccount | null>(null)
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({
    channelIds: [],
    selectedChannelId: null,
    channelConfigs: {},
  })
  const [activeManualSubTab, setActiveManualSubTab] = useState<ManualSubTabId>('channel_instructions')
  const [symbolMappingText, setSymbolMappingText] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [channelConnecting, setChannelConnecting] = useState(false)
  const [configSavedAt, setConfigSavedAt] = useState<number | null>(null)
  const [tradingPresets, setTradingPresets] = useState<ChannelTradingPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetSavedAt, setPresetSavedAt] = useState<number | null>(null)
  const [showPresetNameModal, setShowPresetNameModal] = useState(false)
  const [presetNameDraft, setPresetNameDraft] = useState('')
  const [pendingApplyPreset, setPendingApplyPreset] = useState<ChannelTradingPreset | null>(null)
  const [channelLinkEditMode, setChannelLinkEditMode] = useState(false)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showAddBroker, setShowAddBroker] = useState(false)
  const [form, setForm] = useState<BrokerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [channelsLoading, setChannelsLoading] = useState(() =>
    !(userId && channelOptionsCache.has(userId)),
  )
  const loading =
    (brokersLoading && brokers.length === 0)
    || (channelsLoading && channelOptions.length === 0)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  const [brokerFilter, setBrokerFilter] = useState('all')
  const [brokerSearchQuery, setBrokerSearchQuery] = useState('')
  const [brokerPage, setBrokerPage] = useState(1)
  const [brokerAccountTypes, setBrokerAccountTypes] = useState<Record<string, LinkedAccountType>>({})
  const brokerAccountTypeKey = useMemo(
    () => brokers.map(b => `${b.id}:${b.broker_server ?? ''}`).join('|'),
    [brokers],
  )

  const brokerFilterOptions = useMemo(() => {
    const labels = new Set<string>()
    for (const broker of brokers) {
      const label = resolveBrokerFilterLabel(broker)
      if (label && label !== '—') labels.add(label)
    }
    return [...labels].sort((a, b) => a.localeCompare(b))
  }, [brokers])

  const filteredBrokers = useMemo(() => {
    return brokers.filter(broker => {
      if (brokerFilter !== 'all' && resolveBrokerFilterLabel(broker) !== brokerFilter) return false
      return brokerMatchesSearch(broker, brokerSearchQuery)
    })
  }, [brokers, brokerFilter, brokerSearchQuery])

  const brokerTotalPages = Math.max(1, Math.ceil(filteredBrokers.length / BROKER_PAGE_SIZE))
  const safeBrokerPage = Math.min(brokerPage, brokerTotalPages)

  const paginatedBrokers = useMemo(() => {
    const start = (safeBrokerPage - 1) * BROKER_PAGE_SIZE
    return filteredBrokers.slice(start, start + BROKER_PAGE_SIZE)
  }, [filteredBrokers, safeBrokerPage])

  const brokerRangeStart = filteredBrokers.length === 0 ? 0 : (safeBrokerPage - 1) * BROKER_PAGE_SIZE + 1
  const brokerRangeEnd = Math.min(safeBrokerPage * BROKER_PAGE_SIZE, filteredBrokers.length)

  const linkedBrokerCount = useMemo(
    () => brokers.filter(b => b.is_active).length,
    [brokers],
  )
  const connectedAccountCount = usageLoading ? linkedBrokerCount : usage.brokerAccounts
  const connectedAccountLimit = limits.maxBrokerAccounts

  useEffect(() => {
    setBrokerPage(1)
  }, [brokerFilter, brokerSearchQuery])

  useEffect(() => {
    if (brokerPage > brokerTotalPages) setBrokerPage(brokerTotalPages)
  }, [brokerPage, brokerTotalPages])

  useEffect(() => {
    if (brokers.length > 0) void syncBrokerAccountTypes(brokers)
  }, [brokerAccountTypeKey])

  const channelManualSettings = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id) return DEFAULT_MANUAL_SETTINGS
    return configDraft.channelConfigs[id]?.manualSettings ?? DEFAULT_MANUAL_SETTINGS
  }, [configDraft.selectedChannelId, configDraft.channelConfigs])

  const channelMode = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id) return 'manual' as const
    return configDraft.channelConfigs[id]?.mode ?? 'manual'
  }, [configDraft.selectedChannelId, configDraft.channelConfigs])

  const selectedChannelOption = useMemo(
    () => channelOptions.find(c => c.id === configDraft.selectedChannelId) ?? null,
    [channelOptions, configDraft.selectedChannelId],
  )

  const selectedChannelEditedFromDefault = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id || !configDraft.channelIds.includes(id)) return false
    const entry = configDraft.channelConfigs[id]
    if (!entry) return false
    return !isChannelConfigDefault(entry)
  }, [configDraft.selectedChannelId, configDraft.channelIds, configDraft.channelConfigs])

  const selectedChannelLinked = Boolean(
    configDraft.selectedChannelId
    && configDraft.channelIds.includes(configDraft.selectedChannelId),
  )

  const multiTradePreview = useMemo(() => {
    const ms = channelManualSettings
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
    channelManualSettings.fixed_lot,
    channelManualSettings.multi_trade_leg_percent,
    channelManualSettings.range_trading,
    channelManualSettings.range_percent,
    channelManualSettings.range_step_pips,
    channelManualSettings.range_distance_pips,
  ])

  const brokersNeedingRelink = useMemo(
    () => brokers.filter(b => isLegacyBrokerLink(b.metaapi_account_id)),
    [brokers],
  )

  useEffect(() => {
    setReconnectErrorHandler(message => setError(message))
    return () => setReconnectErrorHandler(null)
  }, [setReconnectErrorHandler])

  const tpLegPercentTotal = useMemo(() => {
    const rows = channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
    return rows.filter(r => r.enabled).reduce((s, r) => s + (Number(r.percent) || 0), 0)
  }, [channelManualSettings.tp_lots])

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
    const raw = (channelManualSettings.symbol_to_trade ?? '').trim()
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
  }, [channelManualSettings.symbol_to_trade])

  /**
   * Pip-count hint: signal pip size (matches backtest) plus optional $/lot from pipCalculator.
   */
  const formatPipHint = useMemo(() => {
    return (pipCount: number): string | null => {
      const raw = (channelManualSettings.symbol_to_trade ?? '').trim()
      if (!raw) return null
      const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
      if (parts.length !== 1) return null
      const symbol = parts[0].toUpperCase()
      const pipPx = signalPipPrice(symbol)
      const klass = classifySymbol(symbol)
      const priceDigits =
        klass === 'fx_major' ? 4
          : klass === 'fx_jpy' ? 2
            : klass === 'index' ? 0
              : 2
      const fmtPrice = (n: number) => n.toFixed(priceDigits)
      const priceOffset = pipCount > 0 ? pipsToPriceOffset(pipCount, symbol) : pipPx
      const fixedLot = Number(channelManualSettings.fixed_lot ?? 0.01) || 0.01
      const perPip = livePipQuote ? pipValueForLots(livePipQuote, fixedLot) : 0
      const ccy = livePipQuote?.quoteCurrency ?? undefined
      const fmtMoney = (n: number) => formatMoneyWithCode(n, ccy, { nullAsDash: false })
      return formatPipHintI18n(cm.pipHint, {
        pipCount,
        symbol,
        fmtPrice,
        priceOffset,
        pipPx,
        fixedLot,
        perPip,
        fmtMoney,
      })
    }
  }, [cm.pipHint, livePipQuote, channelManualSettings.fixed_lot, channelManualSettings.symbol_to_trade])

  useEffect(() => {
    if (!userId) return
    void loadData(userId)
  }, [userId])

  useEffect(() => {
    if (configSavedAt == null) return
    const t = setTimeout(() => setConfigSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [configSavedAt])

  useEffect(() => {
    if (presetSavedAt == null) return
    const t = setTimeout(() => setPresetSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [presetSavedAt])

  const syncSymbolMappingFromChannel = (channelId: string | null, configs: AccountConfigDraft['channelConfigs']) => {
    if (!channelId) {
      setSymbolMappingText('')
      return
    }
    const ms = configs[channelId]?.manualSettings
    setSymbolMappingText(
      Object.entries(ms?.symbol_mapping ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    )
  }

  const refreshTradingPresets = async (uid: string) => {
    setPresetsLoading(true)
    try {
      const rows = await listTradingPresets(uid)
      setTradingPresets(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets')
    } finally {
      setPresetsLoading(false)
    }
  }

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

    // Account type from server name only — avoid summary() here (it can mark brokers disconnected).
  }

  const loadData = async (uid: string) => {
    const cached = channelOptionsCache.get(uid)
    if (cached) {
      setChannelOptions(cached)
      setChannelsLoading(false)
    }
    const channelsRes = await supabase
      .from('telegram_channels')
      .select('id,display_name,channel_username,is_active,created_at')
      .eq('user_id', uid)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    const next = (channelsRes.data ?? []) as ChannelOption[]
    channelOptionsCache.set(uid, next)
    setChannelOptions(next)
    setChannelsLoading(false)
  }

  // ── Configure modal ────────────────────────────────────────────────────

  const openConfigureModal = (broker: BrokerAccount) => {
    const fresh = brokers.find(b => b.id === broker.id) ?? broker
    const channelIds = normalizeSignalChannelIds(fresh).filter(id =>
      channelOptions.some(c => c.id === id),
    )
    setConfigAccount(fresh)
    setActiveManualSubTab('channel_instructions')
    const draft = buildChannelConfigDraftFromBroker(fresh, channelIds)
    setConfigDraft({
      ...draft,
      selectedChannelId: draft.selectedChannelId ?? channelOptions[0]?.id ?? null,
    })
    setChannelLinkEditMode(false)
    syncSymbolMappingFromChannel(draft.selectedChannelId, draft.channelConfigs)
    if (userId) void refreshTradingPresets(userId)
  }

  const selectConfigureChannel = (channelId: string) => {
    setConfigDraft(prev => ({ ...prev, selectedChannelId: channelId }))
    setActiveManualSubTab('channel_instructions')
  }

  const connectSelectedChannelToBroker = async () => {
    if (!configAccount || !user || !configDraft.selectedChannelId) return
    const channelId = configDraft.selectedChannelId
    if (configDraft.channelIds.includes(channelId)) return

    setChannelConnecting(true)
    setError('')
    try {
      const { broker: updated, error: connectErr } = await connectChannelToBroker(
        supabase,
        user.id,
        configAccount,
        channelId,
      )
      if (connectErr) {
        setError(connectErr)
        return
      }
      if (!updated) return

      replaceBroker(updated)
      setConfigAccount(updated)
      const linkedIds = normalizeSignalChannelIds(updated).filter(id =>
        channelOptions.some(c => c.id === id),
      )
      setConfigDraft(prev => {
        const channelConfigs = { ...prev.channelConfigs }
        if (!channelConfigs[channelId]) {
          channelConfigs[channelId] = defaultChannelConfigDraft()
        }
        return {
          ...prev,
          channelIds: linkedIds,
          channelConfigs,
          selectedChannelId: channelId,
        }
      })
      syncSymbolMappingFromChannel(channelId, {
        ...configDraft.channelConfigs,
        [channelId]: configDraft.channelConfigs[channelId] ?? defaultChannelConfigDraft(),
      })
    } finally {
      setChannelConnecting(false)
    }
  }

  useEffect(() => {
    if (!configDraft.selectedChannelId) return
    syncSymbolMappingFromChannel(configDraft.selectedChannelId, configDraft.channelConfigs)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sync textarea when switching channels only
  }, [configDraft.selectedChannelId])

  const closeConfigureModal = () => {
    setConfigAccount(null)
    setSymbolMappingText('')
    setShowPresetNameModal(false)
    setPresetNameDraft('')
    setPendingApplyPreset(null)
    setChannelLinkEditMode(false)
    setError('')
  }

  const toggleDraftChannel = (channelId: string) => {
    setConfigDraft(prev => {
      const willEnable = !prev.channelIds.includes(channelId)
      const channelIds = willEnable
        ? [...prev.channelIds, channelId]
        : prev.channelIds.filter(id => id !== channelId)
      const channelConfigs = { ...prev.channelConfigs }
      if (willEnable && !channelConfigs[channelId]) {
        channelConfigs[channelId] = defaultChannelConfigDraft()
      }
      let selectedChannelId = prev.selectedChannelId
      if (willEnable && !selectedChannelId) selectedChannelId = channelId
      if (!willEnable && selectedChannelId === channelId) {
        selectedChannelId = channelIds[0] ?? null
      }
      return { ...prev, channelIds, channelConfigs, selectedChannelId }
    })
  }

  const setChannelFilter = (
    channelId: string,
    key: ChannelFilterKey,
    value: ChannelFilterDecision,
  ) => {
    setConfigDraft(prev => {
      const entry = prev.channelConfigs[channelId]
      if (!entry) return prev
      const current = entry.channelFilters ?? DEFAULT_CHANNEL_FILTERS
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [channelId]: {
            ...entry,
            channelFilters: { ...current, [key]: value },
          },
        },
      }
    })
  }

  const resetChannelFilters = (channelId: string) => {
    setConfigDraft(prev => {
      const entry = prev.channelConfigs[channelId]
      if (!entry) return prev
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [channelId]: { ...entry, channelFilters: { ...DEFAULT_CHANNEL_FILTERS } },
        },
      }
    })
  }

  const patchSelectedChannel = (
    patch: (current: ChannelConfigDraft) => ChannelConfigDraft,
  ) => {
    setConfigDraft(prev => {
      const id = prev.selectedChannelId
      if (!id || !prev.channelConfigs[id]) return prev
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [id]: patch(prev.channelConfigs[id]),
        },
      }
    })
  }

  const confirmApplyPreset = () => {
    if (!pendingApplyPreset || !configDraft.selectedChannelId) return
    const preset = pendingApplyPreset
    const payload = presetToChannelConfigDraft(preset)
    patchSelectedChannel(() => ({
      mode: payload.mode,
      manualSettings: payload.manualSettings,
      channelFilters: payload.channelFilters,
    }))
    syncSymbolMappingFromChannel(configDraft.selectedChannelId, {
      ...configDraft.channelConfigs,
      [configDraft.selectedChannelId]: {
        mode: payload.mode,
        manualSettings: payload.manualSettings,
        channelFilters: payload.channelFilters,
      },
    })
    setPendingApplyPreset(null)
  }

  const openSavePresetModal = () => {
    if (!configDraft.selectedChannelId || !configDraft.channelConfigs[configDraft.selectedChannelId]) {
      setError(cm.presetSelectChannelFirst)
      return
    }
    setError('')
    setPresetNameDraft(selectedChannelOption?.display_name ?? '')
    setShowPresetNameModal(true)
  }

  const confirmSavePreset = async () => {
    if (!user?.id || !configDraft.selectedChannelId) return
    const entry = configDraft.channelConfigs[configDraft.selectedChannelId]
    if (!entry) return
    const name = presetNameDraft.trim()
    if (!name) return

    setPresetSaving(true)
    setError('')
    try {
      const saved = await upsertTradingPreset(user.id, name, {
        mode: entry.mode,
        manualSettings: entry.manualSettings,
        channelFilters: entry.channelFilters,
      })
      setTradingPresets(prev => {
        const next = prev.filter(p => p.id !== saved.id && p.name !== saved.name)
        return [...next, saved].sort((a, b) => a.name.localeCompare(b.name))
      })
      setShowPresetNameModal(false)
      setPresetNameDraft('')
      setPresetSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.saveAsPreset)
    } finally {
      setPresetSaving(false)
    }
  }

  const setManual = (patch: Partial<ManualSettings>) => {
    patchSelectedChannel(current => ({
      ...current,
      manualSettings: { ...current.manualSettings, ...patch },
    }))
  }

  const updateTpLotRow = (idx: number, patch: Partial<ManualTpLot>) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      rows[idx] = { ...rows[idx], ...patch }
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: rows } }
    })
  }

  const setTpDistributionPercent = (idx: number, raw: string) => {
    const num = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(num)) return
    patchSelectedChannel(current => ({
      ...current,
      manualSettings: {
        ...current.manualSettings,
        tp_lots: applyTpPercentEdit(current.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS, idx, num),
      },
    }))
  }

  const setTpRowEnabled = (idx: number, enabled: boolean) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (!enabled) {
        const othersEnabled = rows.filter((r, i) => i !== idx && r.enabled)
        if (othersEnabled.length === 0) return current
        rows[idx] = { ...rows[idx]!, enabled: false, percent: 0 }
      } else {
        rows[idx] = { ...rows[idx]!, enabled: true }
      }
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const addTpLotRow = () => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (limits.maxTpRows != null && rows.length >= limits.maxTpRows) return current
      rows.push({ label: `TP${rows.length + 1}`, lot: 0.01, percent: 0, enabled: true })
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const removeTpLotRow = (idx: number) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (rows.length <= 1) return current
      rows.splice(idx, 1)
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const setPredefinedTpPipAt = (idx: number, raw: string) => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      if (idx < 0 || idx >= list.length) return current
      if (raw === '') {
        list[idx] = 0
      } else {
        const n = Number(raw)
        if (!Number.isFinite(n)) return current
        list[idx] = n
      }
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const addPredefinedTpPipRow = () => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      const last = list[list.length - 1] ?? 0
      const next = Number.isFinite(last) && last > 0 ? last + 20 : 20
      list.push(next)
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const removePredefinedTpPipRow = (idx: number) => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      if (list.length <= 1) return current
      list.splice(idx, 1)
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const saveConfigureModal = async () => {
    if (!configAccount || !user) return
    setError('')
    const channelIds = configDraft.channelIds
    const restrictChannels = channelIds.length > 0

    if (channelIds.length === 0) {
      const proceed = window.confirm(bl.channelsEmptySaveWarning)
      if (!proceed) return
    }

    setConfigSaving(true)
    const channelMessageFilters: ChannelMessageFiltersMap = {}
    for (const id of channelIds) {
      channelMessageFilters[id] = canUsePlanFeature('channel_keyword_filters')
        ? configDraft.channelConfigs[id]?.channelFilters ?? { ...DEFAULT_CHANNEL_FILTERS }
        : { ...DEFAULT_CHANNEL_FILTERS }
    }
    const channelTradingConfigs = buildChannelTradingConfigsFromDraft(
      channelIds,
      Object.fromEntries(
        channelIds.map(id => [
          id,
          {
            mode: configDraft.channelConfigs[id]?.mode ?? 'manual',
            manualSettings: normalizeManualSettingsForPlan(
              subscription?.plan,
              subscription?.status,
              (configDraft.channelConfigs[id]?.manualSettings ?? DEFAULT_MANUAL_SETTINGS) as Record<string, unknown>,
            ) as ManualSettings,
          },
        ]),
      ),
    )
    const firstId = channelIds[0]
    const firstConfig = firstId ? configDraft.channelConfigs[firstId] : null
    const normalizedFirstManual = firstConfig
      ? normalizeManualSettingsForPlan(
          subscription?.plan,
          subscription?.status,
          {
            ...firstConfig.manualSettings,
            allow_high_impact_news: firstConfig.manualSettings.news_trading_enabled === true,
          } as Record<string, unknown>,
        )
      : {}
    const { data, error: upErr } = await supabase
      .from('broker_accounts')
      .update({
        copier_mode: AI_CONFIGURATION_ENABLED && firstConfig?.mode === 'ai' ? 'ai' : 'manual',
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: restrictChannels,
        channel_trading_configs: channelTradingConfigs,
        manual_settings: firstConfig
          ? normalizedFirstManual
          : {},
        channel_message_filters: channelMessageFilters,
      })
      .eq('id', configAccount.id)
      .eq('user_id', user.id)
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .single()
    setConfigSaving(false)

    if (upErr) { setError(upErr.message); return }

    if (data) {
      const fresh = data as unknown as BrokerAccount
      replaceBroker(fresh)
      setConfigAccount(fresh)
    }
    setConfigSavedAt(Date.now())
  }

  // ── Channel summary helper for cards ───────────────────────────────────

  const getBrokerSignalChannelsLabel = (brokerId: string) => {
    if (channelOptions.length === 0) return bl.channelsNoneSelected
    const brokerRow = brokers.find(b => b.id === brokerId)
    const persistedIds = normalizeSignalChannelIds(brokerRow)
    if (persistedIds.length === 0) return bl.channelsNoneSelected
    const selected = channelOptions.filter(ch => persistedIds.includes(ch.id))
    if (selected.length === 0) return bl.channelsNoneSelected
    if (selected.length === channelOptions.length && channelOptions.length > 1) {
      return bl.channelsAll
    }
    const labels = selected.map(ch => ch.display_name).filter(Boolean)
    if (labels.length) return labels.join(', ')
    return bl.channelsNoneSelected
  }

  // ── Add account flow ───────────────────────────────────────────────────

  const set = (field: keyof BrokerForm, value: string | boolean) =>
    setForm(prev => ({ ...prev, [field]: value }))

  const addBroker = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!canAddBroker()) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    if (!form.account_number.trim() || !form.broker_server.trim() || !form.account_password) {
      setError(t.accountConfig.connectForm.validationRequired)
      return
    }

    setSaving(true)
    const login = form.account_number.trim()
    const server = form.broker_server.trim()
    const duplicate = brokers.find(
      b => b.account_login === login && b.broker_server === server,
    )
    if (duplicate) {
      setError(bl.duplicateMtLogin)
      setSaving(false)
      return
    }

    try {
      const { broker, summary } = await metatraderApi.register({
        platform: form.platform,
        server,
        login,
        password: form.account_password,
        label: form.label.trim() || undefined,
        remember_password: form.remember_password,
      })
      upsertBroker(broker)
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
      setError(err instanceof Error ? err.message : t.accountConfig.connectForm.connectFailed)
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
        const { summary, performance_baseline_balance } = await metatraderApi.summary(brokerId, {
          calendarDay: formatLocalCalendarDay(),
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        })
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
          const match = brokers.find(b => b.id === brokerId)
          const accountType = resolveLinkedAccountType(
            summary.type,
            match ? resolveMtServerCandidate(match, match.broker_server) : null,
          )
          patchBroker(brokerId, patch)
          if (accountType) {
            setBrokerAccountTypes(types => ({ ...types, [brokerId]: accountType }))
          }
          setConfigAccount(prev => prev && prev.id === brokerId ? { ...prev, ...patch } : prev)
          return
        }
      } catch {
        // Keep trying — the MT5 server may still be authenticating.
      }
    }
  }

  const confirmDeleteBroker = async () => {
    if (!brokerPendingDelete || !user) return
    setDeleteInProgress(true)
    setError('')
    const id = brokerPendingDelete.id
    const removed = brokerPendingDelete

    removeBroker(id)
    setBrokerPendingDelete(null)
    if (configAccount?.id === id) closeConfigureModal()
    setBrokerAccountTypes(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })

    try {
      await metatraderApi.remove(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : bl.deleteFailed

      const { error: directDelErr } = await supabase
        .from('broker_accounts')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)

      if (!directDelErr) {
        void metatraderApi.remove(id).catch(() => {})
        return
      }

      const { data: stillThere } = await supabase
        .from('broker_accounts')
        .select('id')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (stillThere) {
        setBrokers(prev => {
          if (prev.some(b => b.id === id)) return prev
          return [...prev, removed].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          )
        })
        setError(/unauthorized/i.test(msg) ? bl.deleteSessionExpired : msg)
      }
    } finally {
      setDeleteInProgress(false)
    }
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    setTogglingBrokerId(id)
    const { error: upErr } = await toggleBrokerActiveInStore(id, is_active)
    setTogglingBrokerId(null)
    if (upErr) setError(upErr)
  }

  // ── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <PageShell maxWidth="lg" spacing="none" className="space-y-3">
        {[...Array(2)].map((_, i) => <div key={i} className="h-28 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-100 dark:border-neutral-800 animate-pulse" />)}
      </PageShell>
    )
  }

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.pages.accountConfiguration.title}
        subtitle={t.pages.accountConfiguration.description}
        actions={(
          <Button size="sm" onClick={() => setShowPlatformModal(true)}>
            <Plus className="w-3.5 h-3.5" />
            {t.accountConfig.connectForm.addAccountButton}
          </Button>
        )}
      />

      {brokersLoadError ? (
        <Alert variant="error" className="mb-3">
          {brokersLoadError}
        </Alert>
      ) : null}

      {/* ── Broker Accounts ── */}
      <section>

        {showAddBroker && (
          <Card className="mb-3">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-4">
              {interpolate(t.accountConfig.connectForm.title, { platform: form.platform })}
            </h3>
            {error && <Alert className="mb-3">{error}</Alert>}
            <form onSubmit={addBroker} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t.accountConfig.connectForm.accountLabel}
                  placeholder={interpolate(t.accountConfig.connectForm.accountLabelPlaceholder, {
                    platform: form.platform,
                  })}
                  value={form.label}
                  onChange={e => set('label', e.target.value)}
                />
                <Select
                  label={t.accountConfig.connectForm.platformLabel}
                  value={form.platform}
                  onChange={e => set('platform', e.target.value as 'MT4' | 'MT5')}
                  options={[
                    { value: 'MT5', label: t.accountConfig.connectForm.platformMt5 },
                    { value: 'MT4', label: t.accountConfig.connectForm.platformMt4 },
                  ]}
                />
              </div>

              <MtCompanyServerPicker
                platform={form.platform}
                value={form.broker_server}
                onChange={(v) => set('broker_server', v)}
                hint={t.accountConfig.connectForm.brokerServerHint}
                required
              />

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t.accountConfig.connectForm.mtLoginLabel}
                  placeholder={t.accountConfig.connectForm.mtLoginPlaceholder}
                  value={form.account_number}
                  onChange={e => set('account_number', e.target.value)}
                  required
                />
                <Input
                  label={t.accountConfig.connectForm.passwordLabel}
                  type="password"
                  placeholder={t.accountConfig.connectForm.passwordPlaceholder}
                  value={form.account_password}
                  onChange={e => set('account_password', e.target.value)}
                  hint={t.accountConfig.connectForm.passwordHint}
                  required
                />
              </div>

              <label className="flex items-start gap-3 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-800/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.remember_password}
                  onChange={e => set('remember_password', e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {t.accountConfig.connectForm.rememberPasswordLabel}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                    {t.accountConfig.connectForm.rememberPasswordHint}
                  </span>
                </span>
              </label>

              <div className="flex gap-2 pt-1">
                <Button type="submit" loading={saving} size="sm">
                  {t.accountConfig.connectForm.connectButton}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowAddBroker(false); setForm(emptyForm); setError('') }}
                >
                  {t.common.cancel}
                </Button>
              </div>
            </form>
          </Card>
        )}

        {brokersNeedingRelink.length > 0 && (
          <Alert variant="warning" className="mb-3">
            {brokersNeedingRelink.length === 1
              ? bl.relinkOne
              : interpolate(bl.relinkMany, { count: String(brokersNeedingRelink.length) })}
          </Alert>
        )}

        {brokersNeedingReconnect.length > 0 && (
          <Alert variant="warning" className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span>{reconnectBannerText}</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0"
              loading={reconnectingBrokerIds.size > 0}
              onClick={() => {
                for (const b of brokersNeedingReconnect) {
                  void reconnectBroker(b.id)
                }
              }}
            >
              <RefreshCw className="w-4 h-4" />
              {bl.reconnectAll}
            </Button>
          </Alert>
        )}

        <p className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-300 flex flex-wrap items-center gap-x-1.5">
          <span>{bl.connectedAccountsHeading}</span>
          <span className="text-neutral-400 font-normal" aria-hidden>
            –
          </span>
          <span className="tabular-nums inline-flex items-center gap-0.5 font-semibold">
            {connectedAccountCount}
            <span className="text-neutral-400 font-normal">/</span>
            {isAdmin ? (
              <Infinity
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
                aria-label={bl.connectedAccountsUnlimited}
              />
            ) : (
              connectedAccountLimit
            )}
          </span>
        </p>

        {brokers.length === 0 ? (
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-8 text-center">
            <Server className="w-8 h-8 mx-auto mb-2 text-neutral-300 dark:text-neutral-600" />
            <p className="text-sm text-neutral-400 dark:text-neutral-500">{t.accountConfig.brokersEmptyTitle}</p>
            <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-0.5">{t.accountConfig.brokersEmptySubtitle}</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {bl.accountSearchLabel}
                  </label>
                  <div className="relative mt-1.5">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                    <input
                      type="search"
                      value={brokerSearchQuery}
                      onChange={e => setBrokerSearchQuery(e.target.value)}
                      placeholder={bl.accountSearchPlaceholder}
                      className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-9 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 hover:border-neutral-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50"
                    />
                  </div>
                </div>
                <div className="w-full sm:w-64">
                  <Select
                    label={bl.brokerFilterLabel}
                    value={brokerFilter}
                    onChange={e => setBrokerFilter(e.target.value)}
                    options={[
                      { value: 'all', label: bl.brokerFilterAll },
                      ...brokerFilterOptions.map(label => ({ value: label, label })),
                    ]}
                  />
                </div>
              </div>
            </div>

            {filteredBrokers.length === 0 ? (
              <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-8 text-center">
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {brokerSearchQuery.trim() ? bl.accountSearchNoMatch : bl.brokerFilterNoMatch}
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {paginatedBrokers.map(broker => {
              const statusVariant = brokerConnectionBadgeVariant(broker)
              const isReconnecting = isBrokerReconnecting(broker.id)
              const statusLabel = brokerConnectionStatusLabel(broker, bl)
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
                          {broker.auto_reconnect_enabled ? (
                            <Badge variant="success" size="sm">{bl.storedCredentialsActive}</Badge>
                          ) : null}
                        </div>
                        {broker.broker_server && (
                          <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{broker.broker_server}</p>
                        )}
                        {(broker.connection_error_kind || broker.connection_error_message) && brokerCanReconnect(broker) ? (
                          <p className="mt-1 text-xs text-error-600 dark:text-error-400 leading-relaxed">
                            {brokerConnectErrorText(
                              broker.connection_error_kind as BrokerConnectErrorKind | null | undefined,
                              broker.connection_error_message,
                              connectErrorLabels,
                            )}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex items-center gap-2 pr-1 border-r border-neutral-200 dark:border-neutral-700 mr-1">
                        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 hidden sm:inline">
                          {bl.copyTrades}
                        </span>
                        <Toggle
                          checked={broker.is_active}
                          onChange={is_active => { void toggleBrokerActive(broker.id, is_active) }}
                          disabled={togglingBrokerId === broker.id}
                        />
                      </div>
                      {brokerCanReconnect(broker) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          loading={isReconnecting}
                          onClick={() => void reconnectBroker(broker.id)}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          {bl.reconnect}
                        </Button>
                      ) : null}
                      {broker.auto_reconnect_enabled ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => { void clearStoredCredentials(broker.id).then(r => { if (r.error) setError(r.error) }) }}
                        >
                          {bl.clearStoredCredentials}
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => openConfigureModal(broker)}
                        className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
                      >
                        {bl.configure}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setError(''); setBrokerPendingDelete(broker) }}
                        className="rounded-lg p-1.5 text-neutral-400 dark:text-neutral-500 hover:bg-error-50 dark:hover:bg-error-950/40 hover:text-error-600 dark:hover:text-error-400 transition-colors"
                        aria-label={interpolate(bl.removeAria, { label: broker.label })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 lg:grid-cols-6">
                    <AccountDetailCell label={bl.detailLogin} value={broker.account_login || '—'} />
                    <AccountDetailCell
                      label={bl.detailAccountType}
                      value={
                        <span className={accountTypeValueClass(accountType)}>
                          {formatLinkedAccountTypeLabel(accountType, {
                            demo: bl.accountTypeDemo,
                            live: bl.accountTypeLive,
                          })}
                        </span>
                      }
                      className="border-l border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailServer}
                      value={broker.broker_server || '—'}
                      className="border-l border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailSignalChannels}
                      value={channelsLabel}
                      className="col-span-2 border-t border-neutral-100 dark:border-neutral-800 lg:col-span-1 lg:border-t-0 lg:border-l"
                    />
                    <AccountDetailCell
                      label={bl.detailBalance}
                      value={formatBrokerMoney(broker.last_balance, broker.last_currency)}
                      className="border-t border-l border-neutral-100 dark:border-neutral-800 lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailEquity}
                      value={formatBrokerMoney(broker.last_equity, broker.last_currency)}
                      className="border-t border-neutral-100 dark:border-neutral-800 lg:border-l lg:border-t-0"
                    />
                  </div>
                </Card>
              )
                  })}
                </div>

                {filteredBrokers.length > 0 && (
                  <AccountBrokerPagination
                    page={safeBrokerPage}
                    totalPages={brokerTotalPages}
                    rangeStart={brokerRangeStart}
                    rangeEnd={brokerRangeEnd}
                    total={filteredBrokers.length}
                    onPageChange={setBrokerPage}
                    previousLabel={t.common.previous}
                    nextLabel={t.common.next}
                    showingRange={interpolate(t.common.showingRange, {
                      start: String(brokerRangeStart),
                      end: String(brokerRangeEnd),
                      total: String(filteredBrokers.length),
                    })}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>

      <AddAccountModal
        open={showPlatformModal}
        onClose={() => setShowPlatformModal(false)}
        onSelect={(platform) => {
          if (platform !== 'MT4' && platform !== 'MT5') {
            setError(interpolate(t.accountConfig.addAccount.comingSoonPlatform, { platform }))
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
                {bl.deleteTitle}
              </h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                {interpolate(bl.deleteBody, { label: brokerPendingDelete.label })}
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
                {t.common.cancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={deleteInProgress}
                onClick={() => void confirmDeleteBroker()}
              >
                {bl.deleteConfirm}
              </Button>
            </div>
          </div>
        </div>
      )}

      {configAccount && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="configure-trading-title"
            className="w-full max-w-5xl h-[100dvh] sm:h-[88vh] max-h-[100dvh] sm:max-h-[88vh] flex flex-col relative rounded-none sm:rounded-2xl bg-white dark:bg-neutral-900 shadow-xl border-0 sm:border border-neutral-200 dark:border-neutral-800 overflow-hidden"
          >
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-start justify-between gap-3 shrink-0">
              <div className="min-w-0 flex-1">
                <h3 id="configure-trading-title" className="text-base sm:text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
                  {cm.title}
                </h3>
                <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                  {configAccount.label} · {configAccount.platform}
                  {selectedChannelOption ? ` · ${selectedChannelOption.display_name}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={closeConfigureModal}
                className="shrink-0 min-h-[44px] px-3 py-2 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {cm.close}
              </button>
            </div>

            <div className="flex flex-col sm:flex-row flex-1 min-h-0 min-w-0">
              {/* Channel sidebar */}
              <nav className="shrink-0 flex sm:flex-col w-full sm:w-56 border-b sm:border-b-0 sm:border-r border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-2 sm:p-3 gap-2 sm:gap-1 overflow-x-auto sm:overflow-y-auto overscroll-x-contain">
                <div className="flex items-center justify-between gap-2 px-2 shrink-0 sm:w-full">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    {cm.channelsSidebar}
                  </p>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        closeConfigureModal()
                        navigate('/channels')
                      }}
                      className="shrink-0 rounded-md p-1.5 transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:text-neutral-300 dark:hover:bg-neutral-800"
                      aria-label={cm.addChannel}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {channelOptions.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setChannelLinkEditMode(v => !v)}
                        className={clsx(
                          'shrink-0 rounded-md p-1.5 transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center',
                          channelLinkEditMode
                            ? 'bg-primary-100 text-primary-700 dark:bg-teal-950/60 dark:text-teal-300'
                            : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        aria-label={channelLinkEditMode ? cm.doneEditingLinkedChannels : cm.editLinkedChannels}
                        aria-pressed={channelLinkEditMode}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>
                {channelOptions.length === 0 ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1">
                    {cm.channels.noneConnected}{' '}
                    <Link to="/channels" className="text-primary-600 underline">{cm.channels.connectLink}</Link>
                  </p>
                ) : (
                  <>
                    {channelOptions.map(channel => {
                      const linked = configDraft.channelIds.includes(channel.id)
                      const selected = configDraft.selectedChannelId === channel.id
                      return (
                        <div key={channel.id} className="flex items-center gap-1 shrink-0 sm:w-full">
                          {channelLinkEditMode ? (
                            <label className="flex items-center gap-2 px-2 py-1 shrink-0">
                              <input
                                type="checkbox"
                                checked={linked}
                                onChange={() => toggleDraftChannel(channel.id)}
                              />
                            </label>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => selectConfigureChannel(channel.id)}
                            className={clsx(
                              'flex-1 min-w-0 flex items-center gap-2 text-left px-2 py-2 rounded-lg text-sm transition-colors min-h-[44px] sm:min-h-0',
                              selected
                                ? 'bg-white dark:bg-neutral-900 text-primary-700 shadow-sm border border-primary-100 dark:border-primary-900/50'
                                : linked
                                  ? 'text-neutral-700 dark:text-neutral-300 hover:bg-white dark:hover:bg-neutral-900 border border-transparent'
                                  : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:hover:bg-neutral-900 border border-dashed border-neutral-200 dark:border-neutral-700',
                            )}
                          >
                            <Radio className={clsx('w-4 h-4 shrink-0', selected ? 'text-primary-600' : linked ? 'text-neutral-400' : 'text-neutral-300')} />
                            <span className="truncate flex-1">{channel.display_name}</span>
                            {!channelLinkEditMode ? (
                              <Badge variant={linked ? 'success' : 'neutral'}>
                                {linked ? cm.channelLinkedBadge : cm.channelNotLinkedBadge}
                              </Badge>
                            ) : null}
                          </button>
                        </div>
                      )
                    })}
                    {channelLinkEditMode ? (
                      <p className="hidden sm:block px-2 pt-2 text-xs text-neutral-500 dark:text-neutral-400">
                        {interpolate(cm.channels.selected, { count: String(configDraft.channelIds.length) })}
                      </p>
                    ) : null}
                  </>
                )}
              </nav>

              {/* Config body column */}
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {selectedChannelLinked ? (
                  <div className="shrink-0 px-4 sm:px-6 pt-3 sm:pt-4 bg-white dark:bg-neutral-900 border-b border-neutral-100 dark:border-neutral-800 overflow-x-auto overscroll-x-contain">
                    <div className="flex flex-nowrap items-center gap-1 min-w-max sm:min-w-0 sm:flex-wrap pb-px">
                      {manualSubTabs.map(sub => {
                          const SubIcon = sub.icon
                          const active = sub.id === activeManualSubTab
                          return (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => setActiveManualSubTab(sub.id)}
                              className={clsx(
                                'shrink-0 flex items-center gap-1.5 px-3 py-2.5 sm:py-2 text-sm transition-colors border-b-2 -mb-px min-h-[44px] sm:min-h-0 whitespace-nowrap',
                                active
                                  ? 'border-primary-600 text-primary-700 dark:text-primary-400'
                                  : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100',
                              )}
                            >
                              <SubIcon className={clsx('w-3.5 h-3.5 shrink-0', active ? 'text-primary-600' : 'text-neutral-400')} />
                              {sub.label}
                            </button>
                          )
                        })}
                    </div>
                  </div>
                ) : null}

                <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-4 sm:py-5 min-h-0 overscroll-y-contain">
                {error && <Alert className="mb-4">{error}</Alert>}

                {!configDraft.selectedChannelId ? (
                  <div className="py-12 text-center">
                    <Radio className="w-10 h-10 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.selectChannelPrompt}</p>
                  </div>
                ) : !selectedChannelLinked ? (
                  <div className="py-12 text-center max-w-md mx-auto px-2">
                    <Link2 className="w-10 h-10 mx-auto mb-3 text-primary-400 dark:text-primary-500" />
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      {interpolate(cm.connectChannelPrompt, {
                        channel: selectedChannelOption?.display_name ?? cm.channelFilters.unnamedChannel,
                        broker: configAccount ? getBrokerDisplayLabel(configAccount) : '—',
                      })}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">{cm.connectChannelHint}</p>
                    <Button
                      className="mt-6 min-h-[44px]"
                      loading={channelConnecting}
                      disabled={configSaving || presetSaving}
                      onClick={() => void connectSelectedChannelToBroker()}
                    >
                      {interpolate(cm.connectChannelButton, {
                        channel: selectedChannelOption?.display_name ?? cm.channelFilters.unnamedChannel,
                        broker: configAccount ? getBrokerDisplayLabel(configAccount) : '—',
                      })}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {/* <div>
                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-2">Configure mode</p>
                      <div className="inline-flex rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-1">
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'ai' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${channelMode === 'ai' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          AI Expert Mode
                        </button>
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'manual' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${channelMode === 'manual' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          Manual
                        </button>
                      </div>
                    </div> */}

                    {AI_CONFIGURATION_ENABLED && channelMode === 'ai' ? (
                      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{cm.ai.title}</p>
                        <p className="text-sm text-neutral-600 dark:text-neutral-400">
                          {cm.ai.intro}
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <FeatureBullet icon={DollarSign} title={cm.ai.moneyManagementTitle} body={cm.ai.moneyManagementBody} />
                          <FeatureBullet icon={Eye} title={cm.ai.signalTitle} body={cm.ai.signalBody} />
                          <FeatureBullet icon={Activity} title={cm.ai.tradeTitle} body={cm.ai.tradeBody} />
                          <FeatureBullet icon={GitBranch} title={cm.ai.modificationTitle} body={cm.ai.modificationBody} />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {activeManualSubTab === 'channel_instructions' && (
                          selectedChannelOption && configDraft.selectedChannelId ? (
                            canUsePlanFeature('channel_keyword_filters') ? (
                            <section className="space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{cm.channels.keywordFilters}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                  {(() => {
                                    const f = normalizeChannelFilters(
                                      configDraft.channelConfigs[configDraft.selectedChannelId]?.channelFilters ?? DEFAULT_CHANNEL_FILTERS,
                                    )
                                    const total = channelFilterCategories.reduce(
                                      (n, c) => n + (f[c.key] === 'ignore' ? 1 : 0), 0,
                                    )
                                    return total === 0
                                      ? cm.channels.allAllowed
                                      : interpolate(cm.channels.ignoredAcross, { total: String(total) })
                                  })()}
                                </p>
                              </div>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">{cm.channels.filtersIntro}</p>
                              <ChannelFiltersCard
                                channel={selectedChannelOption}
                                filters={normalizeChannelFilters(
                                  configDraft.channelConfigs[configDraft.selectedChannelId]?.channelFilters ?? DEFAULT_CHANNEL_FILTERS,
                                )}
                                categories={channelFilterCategories}
                                labels={cm.channelFilters}
                                onChange={(key, value) => setChannelFilter(configDraft.selectedChannelId!, key, value)}
                                onReset={() => resetChannelFilters(configDraft.selectedChannelId!)}
                                defaultOpen
                              />
                            </section>
                            ) : (
                              <UpgradePrompt reason={pw.advancedFeature} />
                            )
                          ) : (
                            <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.channels.selectChannelFirst}</p>
                          )
                        )}

                        {activeManualSubTab === 'symbol_routing' && (
                          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-4">
                            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{cm.symbolRouting.title}</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-1">{cm.symbolRouting.mappingLabel}</p>
                                <textarea
                                  className="w-full min-h-[90px] rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm"
                                  placeholder={cm.symbolRouting.mappingPlaceholder}
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
                                  {cm.symbolRouting.examples}
                                </p>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <Input label={cm.symbolRouting.prefix} value={channelManualSettings.symbol_prefix ?? ''} onChange={e => setManual({ symbol_prefix: e.target.value })} />
                                <Input label={cm.symbolRouting.suffix} value={channelManualSettings.symbol_suffix ?? ''} onChange={e => setManual({ symbol_suffix: e.target.value })} />
                                <div className="col-span-2">
                                  <Input
                                    label={cm.symbolRouting.symbolsToTrade}
                                    placeholder={cm.symbolRouting.symbolsToTradePlaceholder}
                                    value={channelManualSettings.symbol_to_trade ?? ''}
                                    onChange={e => setManual({ symbol_to_trade: e.target.value })}
                                  />
                                  <p className="text-xs text-slate-500 mt-1">
                                    {cm.symbolRouting.symbolsToTradeHint}
                                  </p>
                                </div>
                                <Input
                                  label={cm.symbolRouting.symbolsExclude}
                                  value={(channelManualSettings.symbols_exclude ?? []).join(',')}
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
                                label={cm.risk.riskMode}
                                value={channelManualSettings.risk_mode ?? 'fixed_lot'}
                                onChange={e => setManual({ risk_mode: e.target.value as ManualSettings['risk_mode'] })}
                                options={[
                                  { value: 'fixed_lot', label: cm.risk.fixedLot },
                                  { value: 'dynamic_balance_percent', label: cm.risk.dynamicBalance },
                                ]}
                              />
                              {channelManualSettings.risk_mode === 'dynamic_balance_percent' ? (
                                <Input label={cm.risk.dynamicBalance} type="number" value={String(channelManualSettings.dynamic_balance_percent ?? 1)} onChange={e => setManual({ dynamic_balance_percent: Number(e.target.value) })} />
                              ) : (
                                <Input label={cm.risk.fixedLot} type="number" value={String(channelManualSettings.fixed_lot ?? 0.01)} onChange={e => setManual({ fixed_lot: Number(e.target.value) })} />
                              )}
                              <Select
                                label={cm.risk.tradeStyle}
                                value={channelManualSettings.trade_style ?? 'single'}
                                onChange={e => {
                                  const v = e.target.value as ManualSettings['trade_style']
                                  if (v === 'multi' && !canUsePlanFeature('multi_trade_style')) return
                                  if (v === 'multi') {
                                    setManual({ trade_style: v, use_signal_entry_price: false })
                                  } else {
                                    setManual({ trade_style: v })
                                  }
                                }}
                                options={[
                                  { value: 'single', label: cm.risk.singleTrade },
                                  ...(canUsePlanFeature('multi_trade_style')
                                    ? [{ value: 'multi', label: cm.risk.multiTrades }]
                                    : []),
                                ]}
                              />
                              {!canUsePlanFeature('multi_trade_style') ? (
                                <UpgradePrompt variant="compact" reason={pw.advancedFeature} />
                              ) : null}
                            </div>

                            {channelManualSettings.trade_style !== 'multi' && (
                              <div className="space-y-4">
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.risk.signalEntryTitle}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                  {cm.risk.signalEntryBody}
                                </p>
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.risk.useSignalEntryPrice}</span>
                                    <Toggle
                                      checked={channelManualSettings.use_signal_entry_price === true}
                                      onChange={v => setManual({ use_signal_entry_price: v })}
                                    />
                                  </div>
                                  {channelManualSettings.use_signal_entry_price && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-2">
                                      <Input
                                        label={cm.risk.pipToleranceLegacy}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.risk.pipToleranceHint}
                                        value={String(channelManualSettings.signal_entry_pip_tolerance ?? 10)}
                                        onChange={e => setManual({ signal_entry_pip_tolerance: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                              </div>
                            )}

                            {channelManualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                  {cm.risk.multiIntro}
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <Input
                                    label={cm.risk.perLegSize}
                                    type="number"
                                    min={0.1}
                                    max={100}
                                    step={0.5}
                                    value={String(channelManualSettings.multi_trade_leg_percent ?? 5)}
                                    onChange={e => setManual({ multi_trade_leg_percent: Number(e.target.value) })}
                                  />
                                  <div>
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-1">{cm.risk.totalOpenTrades}</p>
                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-50">
                                      {multiTradePreview.fallsBackSingle
                                        ? cm.risk.previewFallbackSingle
                                        : multiTradePreview.immediate != null && multiTradePreview.pending != null
                                          ? interpolate(cm.risk.previewInstantPending, {
                                              total: String(multiTradePreview.totalOrders),
                                              immediate: String(multiTradePreview.immediate),
                                              pending: String(multiTradePreview.pending),
                                            })
                                          : multiTradePreview.totalOrders}
                                    </div>
                                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                                      {cm.risk.previewFooter}
                                      {channelManualSettings.risk_mode === 'dynamic_balance_percent' && (
                                        <>{cm.risk.previewDynamicRisk}</>
                                      )}
                                      {channelManualSettings.range_trading
                                        && multiTradePreview.effectiveDistancePips != null
                                        && (multiTradePreview.pending ?? 0) > 0
                                        && Math.abs(multiTradePreview.effectiveDistancePips - (Number(channelManualSettings.range_distance_pips ?? 0) || 0)) >= 1 && (
                                        <>
                                          {interpolate(cm.risk.previewLadderSpan, {
                                            pending: String(multiTradePreview.pending),
                                            step: String(Number(channelManualSettings.range_step_pips ?? 0) || 0),
                                            distance: String(multiTradePreview.effectiveDistancePips),
                                            configured: String(Number(channelManualSettings.range_distance_pips ?? 0) || 0),
                                          })}
                                        </>
                                      )}
                                      {channelManualSettings.close_worse_entries && (multiTradePreview.immediate ?? 0) > 0 && (
                                        <>
                                          {interpolate(cm.risk.previewCweLegs, {
                                            count: String(multiTradePreview.immediate),
                                            pips: String(Number(channelManualSettings.close_worse_entries_pips ?? 20) || 0),
                                          })}
                                        </>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {channelManualSettings.trade_style === 'multi' && (
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.risk.rangeLayering}</p>
                                  <Toggle
                                    checked={channelManualSettings.range_trading === true}
                                    onChange={v => setManual({ range_trading: v })}
                                  />
                                </div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                  {cm.risk.rangeIntro}
                                </p>
                                {channelManualSettings.range_trading && (
                                  <>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <Input
                                        label={cm.risk.reservedLot}
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={1}
                                        placeholder="50"
                                        hint={cm.risk.reservedLotHint}
                                        value={String(channelManualSettings.range_percent ?? 50)}
                                        onChange={e => setManual({ range_percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                                      />
                                      <Input
                                        label={cm.risk.stepPips}
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="10"
                                        hint={
                                          formatPipHint(Number(channelManualSettings.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips) || 0)
                                          ?? cm.risk.stepPipsFallback
                                        }
                                        value={String(channelManualSettings.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips)}
                                        onChange={e => setManual({ range_step_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                      <Input
                                        label={cm.risk.rangeDistance}
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="100"
                                        hint={
                                          formatPipHint(Number(channelManualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0)
                                          ?? cm.risk.rangeDistanceFallback
                                        }
                                        value={String(channelManualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips)}
                                        onChange={e => setManual({ range_distance_pips: Math.max(1, Number(e.target.value) || 1) })}
                                      />
                                    </div>

                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-3 space-y-3">
                                      <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.risk.closeWorseEntries}</p>
                                        <Toggle
                                          checked={channelManualSettings.close_worse_entries === true}
                                          onChange={v => setManual({ close_worse_entries: v })}
                                        />
                                      </div>
                                      <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                        {cm.risk.closeWorseBody}
                                      </p>
                                      {channelManualSettings.close_worse_entries && (
                                        <Input
                                          label={cm.risk.closeWorsePips}
                                          type="number"
                                          min={1}
                                          step={1}
                                          placeholder="30"
                                          hint={
                                            formatPipHint(Number(channelManualSettings.close_worse_entries_pips ?? 30) || 0)
                                            ?? cm.risk.closeWorsePipsFallback
                                          }
                                          value={String(channelManualSettings.close_worse_entries_pips ?? 30)}
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

                        {activeManualSubTab === 'stops' && (() => {
                          const ms = channelManualSettings
                          const predefSummary = describePredefinedStopsOverrideI18n(ms, cm.stops)
                          return (
                          <div className="space-y-6">
                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.stops.tpDistributionTitle}</p>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={addTpLotRow}
                                  disabled={
                                    limits.maxTpRows != null
                                    && (channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).length >= limits.maxTpRows
                                  }
                                >
                                  {cm.stops.addTp}
                                </Button>
                              </div>
                              {limits.maxTpRows != null
                                && (channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).length >= limits.maxTpRows ? (
                                  <UpgradePrompt variant="compact" reason={pw.advancedFeature} />
                              ) : null}
                              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                {cm.stops.tpDistributionIntro}
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.stops.multiTradeNote}
                                <br />
                                {cm.stops.singleTradeNote}
                              </p>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-neutral-600 dark:text-neutral-400">
                                  {cm.stops.enabledTotal}{' '}
                                  <strong className={clsx('font-semibold', tpLegPercentTotal === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                                    {tpLegPercentTotal}%
                                  </strong>{' '}
                                  / 100%
                                </span>
                                {tpLegPercentTotal !== 100 && (
                                  <span className="text-amber-600">
                                    {tpLegPercentTotal < 100
                                      ? interpolate(cm.stops.unallocated, { pct: String(100 - tpLegPercentTotal) })
                                      : cm.stops.overCap}
                                  </span>
                                )}
                              </div>
                              <div className="space-y-2">
                                {(channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).map((row, idx) => {
                                  const tpRows = channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
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
                                        title={row.enabled ? interpolate(cm.stops.maxRowTitle, { budget: String(rowBudget) }) : cm.stops.enableRowTitle}
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
                                        {cm.stops.enabled}
                                      </label>
                                      <Button className="col-span-2" variant="ghost" size="sm" onClick={() => removeTpLotRow(idx)}>{cm.stops.remove}</Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </section>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <div>
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.stops.predefinedTitle}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {cm.stops.predefinedIntro}
                                </p>
                              </div>
                              {predefSummary ? (
                                <div className="rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2.5 text-sm text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200">
                                  {predefSummary}
                                </div>
                              ) : null}
                              <div className="space-y-3">
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.stops.overrideSl}</span>
                                    <Toggle checked={ms.use_predefined_sl_pips === true} onChange={v => setManual({ use_predefined_sl_pips: v })} />
                                  </div>
                                  {ms.use_predefined_sl_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3">
                                      <Input
                                        label={cm.stops.slPips}
                                        type="number"
                                        min={1}
                                        step={1}
                                        hint={cm.stops.slPipsHint}
                                        value={String(ms.predefined_sl_pips ?? 30)}
                                        onChange={e => setManual({ predefined_sl_pips: Math.max(1, Number(e.target.value) || 0) })}
                                      />
                                    </div>
                                  )}
                                </div>
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.stops.overrideTps}</span>
                                    <Toggle
                                      checked={ms.use_predefined_tp_pips === true}
                                      onChange={v => {
                                        if (!v) { setManual({ use_predefined_tp_pips: false }); return }
                                        patchSelectedChannel(current => {
                                          let list = current.manualSettings.predefined_tp_pips
                                          if (!Array.isArray(list) || list.length === 0) {
                                            list = [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          } else {
                                            const filtered = list.map(n => Number(n)).filter(Number.isFinite)
                                            list = filtered.length > 0 ? filtered : [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          }
                                          return {
                                            ...current,
                                            manualSettings: {
                                              ...current.manualSettings,
                                              use_predefined_tp_pips: true,
                                              predefined_tp_pips: list,
                                            },
                                          }
                                        })
                                      }}
                                    />
                                  </div>
                                  {ms.use_predefined_tp_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-3">
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-neutral-600 dark:text-neutral-400">
                                          {cm.stops.tpRowsIntro}
                                        </p>
                                        <Button variant="ghost" size="sm" className="shrink-0 self-start sm:self-auto" onClick={addPredefinedTpPipRow}>{cm.stops.addTp}</Button>
                                      </div>
                                      <div className="space-y-2">
                                        {clonePredefinedTpPips(ms.predefined_tp_pips).map((pips, idx) => (
                                          <div key={`predef-tp-${idx}`} className="grid grid-cols-12 gap-2 items-end">
                                            <div className="col-span-10">
                                              <Input
                                                label={interpolate(cm.stops.tpPipsLabel, { index: String(idx + 1) })}
                                                type="number"
                                                min={1}
                                                step={1}
                                                hint={formatPipHint(Number(pips) || 0) ?? undefined}
                                                value={String(pips)}
                                                onChange={e => setPredefinedTpPipAt(idx, e.target.value)}
                                              />
                                            </div>
                                            <Button className="col-span-2" variant="ghost" size="sm" onClick={() => removePredefinedTpPipRow(idx)}>{cm.stops.remove}</Button>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </section>

                          </div>
                          )
                        })()}

                        {activeManualSubTab === 'management' && (() => {
                          const ms = channelManualSettings
                          const autoMgmtEnabled = isAutoManagementEnabled(ms)
                          const triggerMode = ms.move_sl_to_entry_after_mode ?? 'pips'
                          const beType = ms.move_sl_to_entry_type ?? 'sl_only'
                          const autoRuleSummary = describeAutoManagementRuleI18n(ms, cm.management)
                          const isSingleTrade = (ms.trade_style ?? 'single') !== 'multi'
                          const triggerModes = cm.management.triggerModes
                          const TRIGGER_MODES = [
                            { id: 'pips' as const, label: triggerModes.pips, hint: triggerModes.pipsHint },
                            { id: 'rr' as const, label: triggerModes.rr, hint: triggerModes.rrHint },
                            { id: 'money' as const, label: triggerModes.money, hint: triggerModes.moneyHint },
                            { id: 'tp_hit' as const, label: triggerModes.tpHit, hint: triggerModes.tpHitHint },
                          ]
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
                          <div className="space-y-6">
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">
                              {isSingleTrade ? cm.management.monitorIntroSingle : cm.management.monitorIntroMulti}
                            </p>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                              <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-4 py-3">
                                <div>
                                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.management.moveSlTitle}</p>
                                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                    {cm.management.moveSlSubtitle}
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
                                <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-4 py-4 space-y-4">
                                  {autoRuleSummary ? (
                                    <div className="rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2.5 text-sm text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200">
                                      {autoRuleSummary}
                                    </div>
                                  ) : null}

                                  <div className="space-y-3">
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.management.triggerTitle}</p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                      {TRIGGER_MODES.map((m) => (
                                        <button
                                          key={m.id}
                                          type="button"
                                          onClick={() => setManual({ move_sl_to_entry_after_mode: m.id })}
                                          className={clsx(
                                            'rounded-lg border px-2.5 py-2 text-left text-sm transition-colors',
                                            triggerMode === m.id
                                              ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                              : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300',
                                          )}
                                        >
                                          <span className="font-medium block">{m.label}</span>
                                          <span className="text-[10px] opacity-75 block mt-0.5">{m.hint}</span>
                                        </button>
                                      ))}
                                    </div>

                                    {triggerMode === 'pips' && (
                                      <Input
                                        label={cm.management.triggerPips}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.triggerPipsHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'rr' && (
                                      <Input
                                        label={cm.management.triggerRrLabel}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        hint={cm.management.triggerRrHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 1)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'money' && (
                                      <Input
                                        label={cm.management.triggerMoney}
                                        type="number"
                                        min={0}
                                        step={0.01}
                                        hint={cm.management.triggerMoneyHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'tp_hit' && (
                                      <div className="space-y-1.5">
                                        <Select
                                          label={cm.management.takeProfit}
                                          value={String(ms.move_sl_to_entry_tp_index ?? 1)}
                                          onChange={e => setManual({
                                            move_sl_to_entry_tp_index: Math.max(1, Number(e.target.value) || 1),
                                          })}
                                          options={tpOptions}
                                        />
                                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                          {cm.management.tpHitHint}
                                        </p>
                                      </div>
                                    )}

                                    <Input
                                      label={cm.management.breakevenOffset}
                                      type="number"
                                      min={0}
                                      step={1}
                                      hint={cm.management.breakevenOffsetHint}
                                      value={String(ms.breakeven_offset_pips ?? 10)}
                                      onChange={e => setManual({
                                        breakeven_offset_pips: Math.max(0, Number(e.target.value) || 0),
                                      })}
                                    />
                                  </div>

                                  <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
                                    <div className="px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
                                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.management.breakevenTypeTitle}</p>
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                        {cm.management.breakevenTypeSubtitle}
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
                                        <span className="font-medium">{cm.management.moveOnly}</span>
                                        <span className="block text-xs mt-0.5 opacity-80">
                                          {cm.management.moveOnlyHint}
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
                                        <span className="font-medium">{cm.management.moveAndPartial}</span>
                                        <span className="block text-xs mt-0.5 opacity-80">
                                          {cm.management.moveAndPartialHint}
                                        </span>
                                      </button>
                                    </div>
                                    {beType === 'sl_and_close_half' && (
                                      <Input
                                        label={cm.management.partialClose}
                                        type="number"
                                        min={1}
                                        max={99}
                                        step={1}
                                        hint={cm.management.partialCloseHint}
                                        value={String(ms.half_close_percent ?? 50)}
                                        onChange={e =>
                                          setManual({
                                            half_close_percent: Math.min(99, Math.max(1, Number(e.target.value) || 50)),
                                          })
                                        }
                                      />
                                    )}
                                  </div>
                                </div>
                              )}
                            </section>

                            {isSingleTrade && (
                              <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-4 py-3">
                                  <div>
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.management.trailingTitle}</p>
                                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                      {cm.management.trailingSubtitle}
                                    </p>
                                  </div>
                                  <Toggle
                                    checked={ms.trailing_enabled === true}
                                    onChange={v => setManual({ trailing_enabled: v })}
                                  />
                                </div>
                                {ms.trailing_enabled && (
                                  <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-4 py-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                      <Input
                                        label={cm.management.trailStart}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.trailStartHint}
                                        value={String(ms.trailing_start_pips ?? 20)}
                                        onChange={e => setManual({ trailing_start_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                      <Input
                                        label={cm.management.trailStep}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.trailStepHint}
                                        value={String(ms.trailing_step_pips ?? 5)}
                                        onChange={e => setManual({ trailing_step_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                      <Input
                                        label={cm.management.trailDistance}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.trailDistanceHint}
                                        value={String(ms.trailing_distance_pips ?? 10)}
                                        onChange={e => setManual({ trailing_distance_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                    </div>
                                  </div>
                                )}
                              </section>
                            )}

                            {!isSingleTrade && (
                              <p className="text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
                                {cm.management.trailingSingleOnly}
                              </p>
                            )}

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.signalBehavior}</p>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <Select
                                  label={cm.strategy.reverseSignal}
                                  value={ms.reverse_signal ? 'yes' : 'no'}
                                  onChange={e => {
                                    const v = e.target.value === 'yes'
                                    if (v && !reverseSignalPlannerGateSettingsOk(ms)) return
                                    setManual({ reverse_signal: v })
                                  }}
                                  options={[{ value: 'no', label: cm.common.no }, { value: 'yes', label: cm.common.yes }]}
                                />
                                <Select
                                  label={cm.strategy.addToExisting}
                                  value={ms.add_new_trades_to_existing ? 'yes' : 'no'}
                                  onChange={e => setManual({ add_new_trades_to_existing: e.target.value === 'yes' })}
                                  options={[{ value: 'yes', label: cm.common.yes }, { value: 'no', label: cm.common.no }]}
                                />
                                <Select
                                  label={cm.strategy.closeOpposite}
                                  value={ms.close_on_opposite_signal ? 'yes' : 'no'}
                                  onChange={e => setManual({ close_on_opposite_signal: e.target.value === 'yes' })}
                                  options={[{ value: 'no', label: cm.common.no }, { value: 'yes', label: cm.common.yes }]}
                                />
                              </div>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.strategy.reverseHint}
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.strategy.closeOppositeHint}
                              </p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.strategy.addExistingHint}
                              </p>
                            </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.rrFallbacksTitle}</p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.strategy.rrFallbacksIntro}
                              </p>
                              <div className="space-y-3">
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.enableRrSl}</span>
                                    <Toggle
                                      checked={ms.rr_for_sl_enabled === true}
                                      onChange={v => setManual({ rr_for_sl_enabled: v })}
                                    />
                                  </div>
                                  {ms.rr_for_sl_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <Input
                                        label={cm.strategy.slRr}
                                        type="number"
                                        hint={cm.strategy.slRrHint}
                                        value={String(ms.rr_for_sl ?? 1)}
                                        onChange={e => setManual({ rr_for_sl: Number(e.target.value) })}
                                      />
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.enableRrTps}</span>
                                    <Toggle
                                      checked={ms.rr_for_tps_enabled === true}
                                      onChange={v => setManual({ rr_for_tps_enabled: v })}
                                    />
                                  </div>
                                  {ms.rr_for_tps_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <Input
                                        label={cm.strategy.tpRrValues}
                                        hint={cm.strategy.tpRrHint}
                                        value={(ms.rr_for_tps ?? []).join(',')}
                                        onChange={e => setManual({ rr_for_tps: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.pendingTitle}</p>
                              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                {cm.strategy.pendingIntro}
                              </p>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <Input
                                  label={cm.strategy.pendingExpiry}
                                  type="number"
                                  min={1}
                                  max={24}
                                  step={1}
                                  hint={cm.strategy.pendingExpiryHint}
                                  value={String(ms.pending_expiry_hours ?? 1)}
                                  onChange={e => {
                                    const n = Number(e.target.value)
                                    const v = Number.isFinite(n) ? Math.max(1, Math.min(24, Math.floor(n))) : 1
                                    setManual({ pending_expiry_hours: v })
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                          )
                        })()}

                        {activeManualSubTab === 'filters' && (
                          <div className="space-y-6">
                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <div>
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.filters.timeTitle}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {cm.filters.timeSubtitle}
                                </p>
                              </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Select label={cm.filters.timeFilter} value={channelManualSettings.time_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ time_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: cm.filters.timeNo }, { value: 'yes', label: cm.filters.timeYes }]} />
                              {channelManualSettings.time_filter_enabled && (
                                <Input label={cm.filters.startTime} type="time" value={channelManualSettings.trade_start_time ?? '00:00'} onChange={e => setManual({ trade_start_time: e.target.value })} />
                              )}
                              {channelManualSettings.time_filter_enabled && (
                                <Input label={cm.filters.endTime} type="time" value={channelManualSettings.trade_end_time ?? '23:59'} onChange={e => setManual({ trade_end_time: e.target.value })} />
                              )}
                            </div>
                            </section>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <div>
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.filters.daysTitle}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {cm.filters.daysSubtitle}
                                </p>
                              </div>
                              <Select label={cm.filters.daysFilter} value={channelManualSettings.days_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ days_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: cm.filters.daysNo }, { value: 'yes', label: cm.filters.daysYes }]} />
                            {channelManualSettings.days_filter_enabled && (
                              <div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">{cm.filters.tradingDays}</p>
                                <div className="flex flex-wrap gap-3">
                                  {([0, 1, 2, 3, 4, 5, 6] as const).map((value) => (
                                    <label key={value} className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={(channelManualSettings.trade_days ?? [1, 2, 3, 4, 5]).includes(value)}
                                        onChange={(e) => {
                                          const prev = channelManualSettings.trade_days ?? [1, 2, 3, 4, 5]
                                          const next = e.target.checked ? [...new Set([...prev, value])] : prev.filter((x) => x !== value)
                                          setManual({ trade_days: next })
                                        }}
                                      />
                                      {cm.filters.weekdays[String(value) as keyof typeof cm.filters.weekdays]}
                                    </label>
                                  ))}
                                </div>
                                {(channelManualSettings.trade_days ?? []).length === 0 ? (
                                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                                    {cm.filters.daysWarning}
                                  </p>
                                ) : null}
                              </div>
                            )}
                            </section>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <div>
                                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.filters.newsTitle}</p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {cm.filters.newsSubtitle}
                                </p>
                              </div>
                              <Select
                                label={cm.filters.newsTrading}
                                value={channelManualSettings.news_trading_enabled !== false ? 'yes' : 'no'}
                                onChange={e => {
                                  const enabled = e.target.value === 'yes'
                                  setManual({
                                    news_trading_enabled: enabled,
                                    allow_high_impact_news: enabled,
                                  })
                                }}
                                options={[
                                  { value: 'yes', label: cm.filters.newsYes },
                                  { value: 'no', label: cm.filters.newsNo },
                                ]}
                              />
                              {channelManualSettings.news_trading_enabled === false && (
                                <>
                                  <div>
                                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">{cm.filters.avoidImpact}</p>
                                    <div className="flex flex-wrap gap-4">
                                      {(
                                        [
                                          { id: 'high' as const, label: cm.filters.impactHigh },
                                          { id: 'medium' as const, label: cm.filters.impactMedium },
                                          { id: 'low' as const, label: cm.filters.impactLow },
                                        ] as const
                                      ).map((impact) => (
                                        <label key={impact.id} className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            checked={(channelManualSettings.news_avoid_impacts ?? ['high']).includes(impact.id)}
                                            onChange={(e) => {
                                              const prev = channelManualSettings.news_avoid_impacts ?? ['high']
                                              const next = e.target.checked
                                                ? [...new Set([...prev, impact.id])]
                                                : prev.filter((x) => x !== impact.id)
                                              setManual({ news_avoid_impacts: next })
                                            }}
                                          />
                                          {impact.label}
                                        </label>
                                      ))}
                                    </div>
                                    {(channelManualSettings.news_avoid_impacts ?? []).length === 0 ? (
                                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                                        {cm.filters.impactWarning}
                                      </p>
                                    ) : null}
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <Input
                                      label={cm.filters.closeBeforeNews}
                                      type="number"
                                      min={0}
                                      value={String(channelManualSettings.close_before_news_minutes ?? 30)}
                                      onChange={e =>
                                        setManual({ close_before_news_minutes: Math.max(0, Number(e.target.value) || 0) })
                                      }
                                    />
                                    <Input
                                      label={cm.filters.resumeAfterNews}
                                      type="number"
                                      min={0}
                                      value={String(channelManualSettings.resume_after_news_minutes ?? 15)}
                                      onChange={e =>
                                        setManual({ resume_after_news_minutes: Math.max(0, Number(e.target.value) || 0) })
                                      }
                                    />
                                  </div>
                                </>
                              )}
                            </section>
                          </div>
                        )}

                      </div>
                    )}

                  </div>
                )}

                </div>
              </div>
            </div>

            <div className="shrink-0 px-4 sm:px-6 py-3 sm:py-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 sm:gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 sm:mr-auto text-center sm:text-left">
                {configSavedAt != null && (
                  <span className="text-xs text-success-600 transition-opacity">{cm.saved}</span>
                )}
                {presetSavedAt != null && (
                  <span className="text-xs text-success-600 transition-opacity">{cm.presetSaved}</span>
                )}
              </div>
              <Button variant="ghost" className="w-full sm:w-auto min-h-[44px]" onClick={closeConfigureModal} disabled={configSaving || presetSaving}>{cm.cancel}</Button>
              {selectedChannelLinked ? (
                <label className="w-full sm:w-auto min-h-[44px] inline-flex items-stretch rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-sm overflow-hidden has-[:disabled]:opacity-50">
                  <span className="inline-flex items-center px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 border-r border-neutral-200 dark:border-neutral-700 whitespace-nowrap">
                    {cm.applyPreset}
                  </span>
                  <select
                    className="flex-1 min-w-0 sm:min-w-[8rem] text-sm bg-transparent text-neutral-700 dark:text-neutral-200 px-2 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed"
                    defaultValue=""
                    disabled={configSaving || presetSaving || presetsLoading || tradingPresets.length === 0}
                    onChange={e => {
                      const v = e.target.value
                      e.target.value = ''
                      const preset = tradingPresets.find(p => p.id === v)
                      if (preset) setPendingApplyPreset(preset)
                    }}
                  >
                    <option value="" disabled>
                      {presetsLoading
                        ? '…'
                        : tradingPresets.length === 0
                          ? cm.noPresetsYet
                          : cm.applyPresetPlaceholder}
                    </option>
                    {tradingPresets.map(preset => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectedChannelLinked && selectedChannelEditedFromDefault ? (
                <Button
                  variant="secondary"
                  className="w-full sm:w-auto min-h-[44px]"
                  loading={presetSaving}
                  disabled={configSaving || channelConnecting}
                  onClick={openSavePresetModal}
                >
                  <Bookmark className="w-4 h-4 mr-1.5" />
                  {cm.saveAsPreset}
                </Button>
              ) : null}
              {selectedChannelLinked ? (
                <Button
                  className="w-full sm:w-auto min-h-[44px]"
                  loading={configSaving}
                  disabled={presetSaving || channelConnecting}
                  onClick={() => void saveConfigureModal()}
                >
                  {cm.save}
                </Button>
              ) : null}
            </div>

            {pendingApplyPreset ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="apply-preset-title"
                  aria-describedby="apply-preset-description"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl overflow-hidden"
                >
                  <div className="px-5 pt-5 pb-4">
                    <div className="flex gap-3">
                      <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/50">
                        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <h4 id="apply-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                          {cm.applyPresetTitle}
                        </h4>
                        <p id="apply-preset-description" className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                          {interpolate(cm.applyPresetConfirm, {
                            channel: selectedChannelOption?.display_name ?? '—',
                            name: pendingApplyPreset.name,
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-neutral-500 dark:text-neutral-400">{cm.applyPresetChannelLabel}</span>
                        <span className="font-medium text-neutral-900 dark:text-neutral-50 truncate">
                          {selectedChannelOption?.display_name ?? '—'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-neutral-500 dark:text-neutral-400">{cm.applyPresetPresetLabel}</span>
                        <span className="font-medium text-primary-700 dark:text-primary-400 truncate">
                          {pendingApplyPreset.name}
                        </span>
                      </div>
                    </div>
                    <p className="mt-4 text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
                      {cm.applyPresetWarning}
                    </p>
                  </div>
                  <div className="px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      onClick={() => setPendingApplyPreset(null)}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      onClick={confirmApplyPreset}
                    >
                      {cm.applyPresetAction}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {showPresetNameModal ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="save-preset-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 space-y-4"
                >
                  <h4 id="save-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {cm.saveAsPresetTitle}
                  </h4>
                  <Input
                    label={cm.saveAsPresetNameLabel}
                    value={presetNameDraft}
                    placeholder={cm.saveAsPresetNamePlaceholder}
                    onChange={e => setPresetNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void confirmSavePreset()
                    }}
                  />
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      disabled={presetSaving}
                      onClick={() => {
                        setShowPresetNameModal(false)
                        setPresetNameDraft('')
                      }}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      loading={presetSaving}
                      disabled={!presetNameDraft.trim()}
                      onClick={() => void confirmSavePreset()}
                    >
                      {cm.saveAsPresetAction}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </PageShell>
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
  categories,
  labels,
  onChange,
  onReset,
  defaultOpen = false,
}: {
  channel: ChannelOption
  filters: ChannelFilters
  categories: ReturnType<typeof getChannelFilterCategories>
  labels: ConfigureModalTranslations['channelFilters']
  onChange: (key: ChannelFilterKey, value: ChannelFilterDecision) => void
  onReset: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ignoredCount = categories.reduce(
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
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channel.display_name || labels.unnamedChannel}</p>
          {channel.channel_username && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">@{channel.channel_username}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {ignoredCount > 0 && (
            <span className="text-[10px] font-medium uppercase tracking-wide rounded-full px-2 py-0.5 bg-amber-50 text-amber-700">
              {interpolate(labels.ignoredBadge, { count: String(ignoredCount) })}
            </span>
          )}
          <ChevronDown className={clsx('w-4 h-4 text-neutral-500 dark:text-neutral-400 transition-transform', open && 'rotate-180')} />
        </div>
      </button>
      {open && (
        <div className="p-3 border-t border-neutral-100 dark:border-neutral-800 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {categories.map(cat => (
              <CategoryRow
                key={cat.key}
                label={cat.label}
                example={cat.example}
                allowLabel={labels.allow}
                ignoreLabel={labels.ignore}
                value={filters[cat.key] ?? 'allow'}
                onChange={v => onChange(cat.key, v)}
              />
            ))}
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {labels.footer}
            </p>
            <button
              type="button"
              className="text-xs text-primary-600 hover:text-primary-700 hover:underline shrink-0 self-start sm:self-auto"
              onClick={onReset}
              disabled={ignoredCount === 0}
            >
              {labels.resetDefaults}
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
  allowLabel,
  ignoreLabel,
  value,
  onChange,
}: {
  label: string
  example: string
  allowLabel: string
  ignoreLabel: string
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
          {allowLabel}
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
          {ignoreLabel}
        </button>
      </div>
    </div>
  )
}

function AccountBrokerPagination({
  page,
  totalPages,
  onPageChange,
  previousLabel,
  nextLabel,
  showingRange,
}: {
  page: number
  totalPages: number
  rangeStart: number
  rangeEnd: number
  total: number
  onPageChange: (page: number) => void
  previousLabel: string
  nextLabel: string
  showingRange: string
}) {
  const pageNumbers = useMemo(() => {
    const maxButtons = 5
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    let start = Math.max(1, page - 2)
    let end = Math.min(totalPages, start + maxButtons - 1)
    start = Math.max(1, end - maxButtons + 1)
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }, [page, totalPages])

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 sm:px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
        {showingRange}
      </p>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-40 disabled:pointer-events-none"
            aria-label={previousLabel}
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{previousLabel}</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <BrokerPageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-400 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <BrokerPageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-400 text-sm">…</span>
                )}
                <BrokerPageButton
                  n={totalPages}
                  active={page === totalPages}
                  onClick={() => onPageChange(totalPages)}
                />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-40 disabled:pointer-events-none"
            aria-label={nextLabel}
          >
            <span className="hidden sm:inline">{nextLabel}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

function BrokerPageButton({
  n,
  active,
  onClick,
}: {
  n: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'min-w-[2rem] px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors',
        active
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border border-transparent hover:border-neutral-200 dark:hover:border-neutral-800',
      )}
    >
      {n}
    </button>
  )
}

