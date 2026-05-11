import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import type { BrokerAccount } from '../../types/database'
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

interface BrokerSummaryResult {
  summary: { balance?: number; equity?: number; currency?: string }
  error?: string
}

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
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({ mode: 'ai', channelIds: [] })
  const [configSaving, setConfigSaving] = useState(false)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showAddBroker, setShowAddBroker] = useState(false)
  const [form, setForm] = useState<BrokerForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [connectingBroker, setConnectingBroker] = useState(false)
  const [serverSuggestions, setServerSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)

  const EDGE_CONNECT_BROKER = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connect-metatrader-account`
  const EDGE_DELETE_BROKER = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-metatrader-account`
  const EDGE_SERVER_SUGGESTIONS = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mt-server-suggestions`
  const EDGE_ACCOUNT_SUMMARY = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/metatrader-account-summary`

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
    setConfigDraft({
      mode: fresh.copier_mode === 'manual' ? 'manual' : 'ai',
      channelIds,
    })
  }

  const closeConfigureModal = () => {
    setConfigAccount(null)
  }

  const toggleDraftChannel = (channelId: string) => {
    setConfigDraft(prev => ({
      ...prev,
      channelIds: prev.channelIds.includes(channelId)
        ? prev.channelIds.filter(id => id !== channelId)
        : [...prev.channelIds, channelId],
    }))
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
    const token = (await supabase.auth.getSession()).data.session?.access_token
    if (!token) return
    const pairs = await Promise.all(rows.map(async (broker): Promise<readonly [string, BrokerSummaryResult]> => {
      try {
        const res = await fetch(EDGE_ACCOUNT_SUMMARY, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ broker_account_id: broker.id }),
        })
        const data = await res.json()
        if (!res.ok || !data?.summary) {
          return [broker.id, { summary: {}, error: data?.error || 'Unavailable' }] as const
        }
        const summary = data.summary as Record<string, unknown>
        const balance = Number(summary.balance ?? summary.Balance)
        const equity = Number(summary.equity ?? summary.Equity)
        const currency = String(summary.currency ?? summary.Currency ?? '')
        return [broker.id, { summary: {
          balance: Number.isFinite(balance) ? balance : undefined,
          equity: Number.isFinite(equity) ? equity : undefined,
          currency: currency || undefined,
        } }] as const
      } catch {
        return [broker.id, { summary: {}, error: 'Unavailable' }] as const
      }
    }))
    const summaryMap: Record<string, { balance?: number; equity?: number; currency?: string }> = {}
    const errorMap: Record<string, string> = {}
    for (const [id, payload] of pairs) {
      summaryMap[id] = payload.summary
      if (payload.error) errorMap[id] = payload.error
    }
    setBrokerSummaries(summaryMap)
    setBrokerSummaryErrors(errorMap)
  }

  const loadServerSuggestions = async (q: string, platform: string) => {
    if (platform !== 'MT4' && platform !== 'MT5') {
      setServerSuggestions([])
      return
    }
    setLoadingSuggestions(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) {
        setLoadingSuggestions(false)
        return
      }
      const res = await fetch(`${EDGE_SERVER_SUGGESTIONS}?platform=${encodeURIComponent(platform)}&q=${encodeURIComponent(q)}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setServerSuggestions([])
      } else {
        setServerSuggestions((data.suggestions ?? []) as string[])
      }
    } catch {
      setServerSuggestions([])
    } finally {
      setLoadingSuggestions(false)
    }
  }

  const addBroker = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.account_number.trim() || !form.account_password.trim() || !form.broker_server.trim()) {
      setError('Account number, password, and server are required')
      return
    }

    if (form.platform === 'MT4' || form.platform === 'MT5') {
      setConnectingBroker(true)
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token
        if (!token) {
          setError('You are not authenticated')
          setConnectingBroker(false)
          return
        }

        const connectRes = await fetch(EDGE_CONNECT_BROKER, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            label: form.label,
            platform: form.platform,
            account_number: form.account_number.trim(),
            account_password: form.account_password,
            server: form.broker_server.trim(),
            default_lot_size: DEFAULT_LOT_SIZE,
            pip_tolerance: DEFAULT_PIP_TOLERANCE,
          }),
        })
        const connectData = await connectRes.json()
        if (!connectRes.ok || !connectData.ok) {
          setError(connectData.error || 'Broker account connection failed')
          setConnectingBroker(false)
          return
        }

        setBrokers(prev => [...prev, connectData.broker_account as BrokerAccount])
        void loadBrokerSummaries([...brokers, connectData.broker_account as BrokerAccount])
        setForm(emptyForm)
        setShowAddBroker(false)
      } catch {
        setError('Failed to connect account')
        setConnectingBroker(false)
        return
      } finally {
        setConnectingBroker(false)
      }
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
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) {
        setBrokers(previous)
        setError('You are not authenticated')
        return false
      }

      const res = await fetch(EDGE_DELETE_BROKER, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ broker_account_id: id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok !== true) {
        setBrokers(previous)
        setError(data?.error || 'Failed to delete broker account')
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
                <Button type="submit" loading={saving || connectingBroker} size="sm">Connect account</Button>
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
                <div className="rounded-xl border border-neutral-200 p-4">
                  <p className="text-sm font-semibold text-neutral-900">Manual Configuration</p>
                  <p className="text-sm text-neutral-500 mt-1">Manual configuration options will be added in the next phase.</p>
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
