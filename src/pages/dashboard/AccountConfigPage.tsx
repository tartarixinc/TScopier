import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import type { BrokerAccount, ManualSettings, ManualTpLot } from '../../types/database'
import { Plus, Trash2, Server, DollarSign, Eye, Activity, GitBranch } from 'lucide-react'
import { AddAccountModal } from '../../components/ui/AddAccountModal'

const PLATFORMS = [
  { value: 'MT5', label: 'MetaTrader 5 (MT5)' },
  { value: 'MT4', label: 'MetaTrader 4 (MT4)' },
  { value: 'cTrader', label: 'cTrader' },
  { value: 'DXTrade', label: 'DXTrade' },
  { value: 'TradeLocker', label: 'TradeLocker' },
]

interface BrokerForm {
  label: string
  platform: string
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

const DEFAULT_LOT_SIZE = 0.01
const DEFAULT_PIP_TOLERANCE = 20

interface ChannelOption {
  id: string
  display_name: string
  channel_username: string
  is_active: boolean
  created_at: string
}

/** First-added channel (oldest created_at); stable tie-break on id. */
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
  { label: 'TP1', lot: 0.01, enabled: true },
  { label: 'TP2', lot: 0.01, enabled: true },
  { label: 'TP3', lot: 0.01, enabled: true },
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
  trade_style: 'single',
  range_trading: false,
  range_total_lot: 0.03,
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

function normalizeManualSettings(raw: unknown): ManualSettings {
  const j = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const map = j.symbol_mapping && typeof j.symbol_mapping === 'object' ? j.symbol_mapping as Record<string, unknown> : {}
  const tpLotsRaw = Array.isArray(j.tp_lots) ? j.tp_lots : DEFAULT_MANUAL_TP_LOTS
  const tpLots = tpLotsRaw.map((x, i) => {
    const row = (x && typeof x === 'object') ? x as Record<string, unknown> : {}
    return {
      label: String(row.label ?? `TP${i + 1}`),
      lot: Number(row.lot ?? 0.01) || 0.01,
      enabled: row.enabled !== false,
    } as ManualTpLot
  })
  return {
    ...DEFAULT_MANUAL_SETTINGS,
    ...j as ManualSettings,
    symbol_mapping: Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
    symbols_exclude: Array.isArray(j.symbols_exclude) ? j.symbols_exclude.map(String).map(s => s.toUpperCase()) : [],
    tp_lots: tpLots,
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

  if (!iconPath || failed) {
    return <Server className="w-4 h-4 text-primary-600" />
  }

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

export function AccountConfigPage() {
  const { user } = useAuth()
  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [brokerSummaries, setBrokerSummaries] = useState<Record<string, { balance?: number; equity?: number; currency?: string }>>({})
  const [brokerSummaryErrors, setBrokerSummaryErrors] = useState<Record<string, string>>({})
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([])
  const [configAccount, setConfigAccount] = useState<BrokerAccount | null>(null)
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({
    mode: 'ai',
    channelIds: [],
    manualSettings: { ...DEFAULT_MANUAL_SETTINGS },
  })
  const [symbolMappingText, setSymbolMappingText] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showAddBroker, setShowAddBroker] = useState(false)
  const [form, setForm] = useState<BrokerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [serverSuggestions, setServerSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)


  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  useEffect(() => {
    if (!showAddBroker) return
    if (form.platform !== 'MT4' && form.platform !== 'MT5') return
    const q = form.broker_server.trim()
    const timeout = window.setTimeout(() => {
      void loadServerSuggestions(q, form.platform)
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [showAddBroker, form.platform, form.broker_server])

  const loadData = async () => {
    const [brokersRes, channelsRes] = await Promise.all([
      supabase.from('broker_accounts').select('*').eq('user_id', user!.id).order('created_at'),
      supabase.from('telegram_channels').select('id,display_name,channel_username,is_active,created_at').eq('user_id', user!.id).eq('is_active', true).order('created_at', { ascending: false }),
    ])
    const nextBrokers = (brokersRes.data ?? []) as BrokerAccount[]
    setBrokers(nextBrokers)
    setChannelOptions((channelsRes.data ?? []) as ChannelOption[])
    void loadBrokerSummaries(nextBrokers)
    setLoading(false)
  }

  const openConfigureModal = (broker: BrokerAccount) => {
    const fresh = brokers.find(b => b.id === broker.id) ?? broker
    const persistedIds = normalizeSignalChannelIds(fresh)
    const restricts = fresh.enforce_signal_channel_filter === true
    let channelIds: string[]
    if (channelOptions.length === 1 && channelOptions[0]) {
      channelIds = [channelOptions[0].id]
    } else if (channelOptions.length > 1) {
      // When not restricting, treat as all channels selected in the UI.
      channelIds =
        restricts && persistedIds.length > 0 ? persistedIds : channelOptions.map(c => c.id)
    } else {
      channelIds = persistedIds
    }
    setConfigAccount(fresh)
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
      manualSettings: {
        ...prev.manualSettings,
        ...patch,
      },
    }))
  }

  const updateTpLotRow = (idx: number, patch: Partial<ManualTpLot>) => {
    setConfigDraft(prev => {
      const rows = [...(prev.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS)]
      rows[idx] = { ...rows[idx], ...patch }
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: rows } }
    })
  }

  const addTpLotRow = () => {
    setConfigDraft(prev => {
      const rows = [...(prev.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS)]
      rows.push({ label: `TP${rows.length + 1}`, lot: 0.01, enabled: true })
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: rows } }
    })
  }

  const removeTpLotRow = (idx: number) => {
    setConfigDraft(prev => {
      const rows = [...(prev.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS)]
      if (rows.length <= 1) return prev
      rows.splice(idx, 1)
      return { ...prev, manualSettings: { ...prev.manualSettings, tp_lots: rows } }
    })
  }

  const saveConfigureModal = async () => {
    if (!configAccount || !user) return
    setError('')
    let channelIds = configDraft.channelIds
    let restrictChannels = false
    // One Telegram channel: persist {} — matches "copy all" semantics and avoids locking to UUID only.
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

    if (upErr) {
      setError(upErr.message)
      return
    }

    if (data) {
      setBrokers(prev => prev.map(b => (b.id === configAccount.id ? (data as BrokerAccount) : b)))
    }
    closeConfigureModal()
  }

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
    if (!restricts || persistedIds.length === 0) {
      return 'All signal channels'
    }
    const labels = channelOptions
      .filter(ch => persistedIds.includes(ch.id))
      .map(ch => ch.display_name)
      .filter(Boolean)
    if (labels.length) return labels.join(', ')
    return 'None selected'
  }

  const set = (field: keyof BrokerForm, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }))

  const loadBrokerSummaries = async (rows: BrokerAccount[]) => {
    const summaryMap: Record<string, { balance?: number; equity?: number; currency?: string }> = {}
    for (const b of rows) summaryMap[b.id] = {}
    setBrokerSummaries(summaryMap)
    setBrokerSummaryErrors({})
  }

  const loadServerSuggestions = async (_q: string, _platform: string) => {
    setServerSuggestions([])
    setLoadingSuggestions(false)
  }

  const addBroker = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.account_number.trim() || !form.broker_server.trim()) {
      setError('Account number and server are required')
      return
    }

    setSaving(true)

    const { data, error: dbErr } = await supabase
      .from('broker_accounts')
      .insert({
        user_id: user!.id,
        label: form.label || `${form.platform} – ${form.account_number}`,
        platform: form.platform,
        metaapi_account_id: `${form.broker_server.trim()}|${form.account_number.trim()}`,
        broker_server: form.broker_server.trim(),
        copier_mode: 'ai',
        signal_channel_ids: [],
        enforce_signal_channel_filter: false,
        ai_settings: {},
        manual_settings: DEFAULT_MANUAL_SETTINGS,
        default_lot_size: DEFAULT_LOT_SIZE,
        pip_tolerance: DEFAULT_PIP_TOLERANCE,
        is_active: true,
        max_trades_per_zone: 1,
      })
      .select('*')
      .single()

    setSaving(false)
    if (dbErr) { setError(dbErr.message); return }

    setBrokers(prev => [...prev, data as BrokerAccount])
    setForm(emptyForm)
    setShowAddBroker(false)
  }

  const deleteBroker = async (id: string): Promise<boolean> => {
    setError('')
    const previous = brokers
    setBrokers(prev => prev.filter(b => b.id !== id))
    try {
      const { error: delErr } = await supabase
        .from('broker_accounts')
        .delete()
        .eq('id', id)
        .eq('user_id', user!.id)
      if (delErr) {
        setBrokers(previous)
        setError(delErr.message)
        return false
      }
      setBrokerSummaries(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setBrokerSummaryErrors(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return true
    } catch {
      setBrokers(previous)
      setError('Failed to delete broker account')
      return false
    }
  }

  const confirmDeleteBroker = async () => {
    if (!brokerPendingDelete) return
    setDeleteInProgress(true)
    const ok = await deleteBroker(brokerPendingDelete.id)
    setDeleteInProgress(false)
    if (ok) setBrokerPendingDelete(null)
  }

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
        <h1 className="text-2xl font-bold text-neutral-900">Account & Configuration</h1>
        <p className="text-sm text-neutral-500 mt-0.5">Configure your trading accounts</p>
      </div>

      {/* ── Broker Accounts ── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900">Trading Accounts</h2>
            <p className="text-xs text-neutral-400 mt-0.5">Connect your broker accounts.</p>
          </div>
          <Button size="sm" onClick={() => setShowPlatformModal(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add account
          </Button>
        </div>

        {showAddBroker && (
          <Card className="mb-3">
            <h3 className="text-sm font-semibold text-neutral-900 mb-4">New broker account</h3>
            {error && (
              <div className="mb-3 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">{error}</div>
            )}
            <form onSubmit={addBroker} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Select label="Platform" options={PLATFORMS} value={form.platform} onChange={e => set('platform', e.target.value)} />
                <Input label="Account label (optional)" placeholder="e.g. Live MT5" value={form.label} onChange={e => set('label', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Account number"
                  placeholder="Trading account number"
                  value={form.account_number}
                  onChange={e => set('account_number', e.target.value)}
                  required
                />
                <Input
                  label="Account password"
                  type="password"
                  placeholder="Trading account password"
                  value={form.account_password}
                  onChange={e => set('account_password', e.target.value)}
                  required
                />
              </div>
              <div className="relative">
                <Input
                  label="Broker server"
                  placeholder={loadingSuggestions ? 'Searching server suggestions...' : 'e.g. ICMarketsSC-MT5-2'}
                  value={form.broker_server}
                  onChange={e => {
                    set('broker_server', e.target.value)
                    setShowSuggestions(true)
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => window.setTimeout(() => setShowSuggestions(false), 120)}
                  hint="Type to see suggestions. Unknown server is still allowed."
                  required
                />
                {showSuggestions && serverSuggestions.length > 0 && (
                  <div className="absolute z-20 top-[72px] left-0 right-0 bg-white border border-neutral-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                    {serverSuggestions.map(server => (
                      <button
                        key={server}
                        type="button"
                        onMouseDown={() => {
                          set('broker_server', server)
                          setShowSuggestions(false)
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                      >
                        {server}
                      </button>
                    ))}
                  </div>
                )}
                {showSuggestions && !loadingSuggestions && form.broker_server.trim() && serverSuggestions.length === 0 && (
                  <div className="absolute z-20 top-[72px] left-0 right-0 bg-white border border-neutral-200 rounded-lg shadow-lg px-3 py-2 text-xs text-neutral-500">
                    No suggestion match. You can still use this server.
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="submit" loading={saving} size="sm">Save account</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddBroker(false); setForm(emptyForm); setError('') }}>Cancel</Button>
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
            {brokers.map(broker => (
              <Card key={broker.id} padding="sm">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <PlatformIcon platform={broker.platform} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-neutral-900">{broker.label}</p>
                      <Badge variant={broker.is_active ? 'success' : 'neutral'} size="sm">
                        {broker.is_active ? 'Active' : 'Paused'}
                      </Badge>
                      <Badge variant="neutral" size="sm">{broker.platform}</Badge>
                    </div>
                    {/* <p className="text-xs text-neutral-400 mt-0.5">
                      Lot: {broker.default_lot_size} · Pip tolerance: {broker.pip_tolerance}
                    </p> */}
                    <p className="text-xs text-neutral-500 mt-0.5">
                      <span className="font-medium text-neutral-700">Signal Channels:</span> {getBrokerSignalChannelsLabel(broker.id)}
                    </p>
                    {(brokerSummaries[broker.id]?.balance != null || brokerSummaries[broker.id]?.equity != null) && (
                      <p className="text-xs text-neutral-500 mt-0.5">
                        {brokerSummaries[broker.id]?.balance != null && (
                          <span>
                            Balance: {brokerSummaries[broker.id]?.balance?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {brokerSummaries[broker.id]?.currency ?? ''}
                          </span>
                        )}
                        {brokerSummaries[broker.id]?.balance != null && brokerSummaries[broker.id]?.equity != null && ' · '}
                        {brokerSummaries[broker.id]?.equity != null && (
                          <span>
                            Equity: {brokerSummaries[broker.id]?.equity?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {brokerSummaries[broker.id]?.currency ?? ''}
                          </span>
                        )}
                      </p>
                    )}
                    {!(brokerSummaries[broker.id]?.balance != null || brokerSummaries[broker.id]?.equity != null) && brokerSummaryErrors[broker.id] && (
                      <p className="text-xs text-warning-600 mt-0.5">
                        Balance unavailable
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
            ))}
          </div>
        )}
      </section>

      <AddAccountModal
        open={showPlatformModal}
        onClose={() => setShowPlatformModal(false)}
        onSelect={(platform) => {
          setForm(prev => ({ ...prev, platform }))
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
                This disconnects <span className="font-medium text-neutral-800">{brokerPendingDelete.label}</span> from the copier. This cannot be undone.
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
          <div className="w-full max-w-5xl max-h-[88vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-neutral-200">
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

            <div className="px-6 py-5 space-y-6">
              <div>
                <p className="text-sm font-medium text-neutral-800 mb-2">Configuration Mode</p>
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

              {(channelOptions.length === 0 || channelOptions.length > 1) && (
                <div className="rounded-xl border border-neutral-200 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-semibold text-neutral-900">Signal Channels</p>
                    {channelOptions.length > 1 && (
                      <p className="text-xs text-neutral-500">{configDraft.channelIds.length} selected</p>
                    )}
                  </div>
                  {channelOptions.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      No connected channels found. <Link to="/copier-engine" className="text-primary-600 underline">Connect channels here</Link>.
                    </p>
                  ) : (
                    <>
                    <p className="text-xs text-neutral-500 mb-3">
                      All channels selected (default) copies every connected Telegram channel. Uncheck one or more to restrict this broker — only then is the filter enforced.
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

              {configDraft.mode === 'ai' ? (
                <div className="rounded-xl border border-neutral-200 p-4 space-y-3">
                  <p className="text-sm font-semibold text-neutral-900">AI Configuration</p>
                  <p className="text-sm text-neutral-600">
                  AI expert mode is designed to behave like a human expert trader: dynamic lot sizing by balance, maximum lots per signal,
                  range entry handling, TP-based management, and channel instruction interpretation.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                      <p className="text-xs font-medium text-neutral-700 mb-1 flex items-center gap-1.5">
                        <DollarSign className="w-3.5 h-3.5 text-primary-600" />
                        Money Management
                      </p>
                      <p className="text-xs text-neutral-500" title="Forex SL distance can refine linear lots when price context is small.">
                        Linear sizing by default; optional margin mode; broker min lot floor; forex SL-distance refinement when applicable.
                      </p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                      <p className="text-xs font-medium text-neutral-700 mb-1 flex items-center gap-1.5">
                        <Eye className="w-3.5 h-3.5 text-primary-600" />
                        Signal Interpretation
                      </p>
                      <p className="text-xs text-neutral-500">Handles no-entry, single-entry, range-entry, and delayed TP/SL updates.</p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                      <p className="text-xs font-medium text-neutral-700 mb-1 flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-primary-600" />
                        Trade Management
                      </p>
                      <p className="text-xs text-neutral-500">Supports partials, break-even logic, and channel commands like close/secure profits.</p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-3">
                      <p className="text-xs font-medium text-neutral-700 mb-1 flex items-center gap-1.5">
                        <GitBranch className="w-3.5 h-3.5 text-primary-600" />
                        Modification Detection
                      </p>
                      <p className="text-xs text-neutral-500">Distinguishes new entries from follow-up modification instructions.</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-neutral-200 p-4 space-y-4">
                  <p className="text-sm font-semibold text-neutral-900">Manual Configuration</p>
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
                      <Input label="Symbol To Trade" value={configDraft.manualSettings.symbol_to_trade ?? ''} onChange={e => setManual({ symbol_to_trade: e.target.value })} />
                      <Input
                        label="Symbols to Exclude (comma)"
                        value={(configDraft.manualSettings.symbols_exclude ?? []).join(',')}
                        onChange={e => setManual({ symbols_exclude: e.target.value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) })}
                      />
                    </div>
                  </div>

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

                  <div className="rounded-lg border border-neutral-200 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-neutral-800">TP Lot Sizes</p>
                      <Button variant="ghost" onClick={addTpLotRow}>Add TP</Button>
                    </div>
                    <div className="space-y-2">
                      {(configDraft.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).map((row, idx) => (
                        <div key={`${row.label}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                          <input className="col-span-4 rounded-md border border-neutral-200 px-2 py-1.5 text-sm" value={row.label} onChange={e => updateTpLotRow(idx, { label: e.target.value })} />
                          <input className="col-span-3 rounded-md border border-neutral-200 px-2 py-1.5 text-sm" type="number" value={row.lot} onChange={e => updateTpLotRow(idx, { lot: Number(e.target.value) })} />
                          <label className="col-span-3 text-xs text-neutral-700 flex items-center gap-2">
                            <input type="checkbox" checked={row.enabled} onChange={e => updateTpLotRow(idx, { enabled: e.target.checked })} />
                            Enabled
                          </label>
                          <Button className="col-span-2" variant="ghost" onClick={() => removeTpLotRow(idx)}>Remove</Button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Select label="Range Trading" value={configDraft.manualSettings.range_trading ? 'yes' : 'no'} onChange={e => setManual({ range_trading: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                    {configDraft.manualSettings.range_trading && (
                      <Input label="Range Total Lot" type="number" value={String(configDraft.manualSettings.range_total_lot ?? 0.03)} onChange={e => setManual({ range_total_lot: Number(e.target.value) })} />
                    )}
                    <Select label="Reverse Signal" value={configDraft.manualSettings.reverse_signal ? 'yes' : 'no'} onChange={e => setManual({ reverse_signal: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.use_predefined_sl_pips === true} onChange={e => setManual({ use_predefined_sl_pips: e.target.checked })} />Use Predefined SL Pips</label>
                    {configDraft.manualSettings.use_predefined_sl_pips && (
                      <Input label="Predefined SL Pips" type="number" value={String(configDraft.manualSettings.predefined_sl_pips ?? 30)} onChange={e => setManual({ predefined_sl_pips: Number(e.target.value) })} />
                    )}
                    <label className="text-sm text-neutral-700 flex items-center gap-2"><input type="checkbox" checked={configDraft.manualSettings.use_predefined_tp_pips === true} onChange={e => setManual({ use_predefined_tp_pips: e.target.checked })} />Use Predefined TPs</label>
                    {configDraft.manualSettings.use_predefined_tp_pips && (
                      <Input label="Predefined TP Pips (comma)" value={(configDraft.manualSettings.predefined_tp_pips ?? []).join(',')} onChange={e => setManual({ predefined_tp_pips: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })} />
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

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <Select label="Trailing SL" value={configDraft.manualSettings.trailing_enabled ? 'yes' : 'no'} onChange={e => setManual({ trailing_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                    <Input label="Trail Start (pips)" type="number" value={String(configDraft.manualSettings.trailing_start_pips ?? 20)} onChange={e => setManual({ trailing_start_pips: Number(e.target.value) })} />
                    <Input label="Trail Step (pips)" type="number" value={String(configDraft.manualSettings.trailing_step_pips ?? 5)} onChange={e => setManual({ trailing_step_pips: Number(e.target.value) })} />
                    <Input label="Trail Distance (pips)" type="number" value={String(configDraft.manualSettings.trailing_distance_pips ?? 10)} onChange={e => setManual({ trailing_distance_pips: Number(e.target.value) })} />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Select label="Time Filter" value={configDraft.manualSettings.time_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ time_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                    {configDraft.manualSettings.time_filter_enabled && (
                      <Input label="Start Time" type="time" value={configDraft.manualSettings.trade_start_time ?? '00:00'} onChange={e => setManual({ trade_start_time: e.target.value })} />
                    )}
                    {configDraft.manualSettings.time_filter_enabled && (
                      <Input label="End Time" type="time" value={configDraft.manualSettings.trade_end_time ?? '23:59'} onChange={e => setManual({ trade_end_time: e.target.value })} />
                    )}
                    <Select label="Days Filter" value={configDraft.manualSettings.days_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ days_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
                    {configDraft.manualSettings.days_filter_enabled && (
                      <div className="md:col-span-2">
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
