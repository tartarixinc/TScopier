import { useEffect, useState } from 'react'
import { Radio, Trash2, RefreshCw, CircleAlert as AlertCircle, ChevronDown, Settings } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Toggle } from '../../components/ui/Toggle'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import type { ChannelKeywords, ChannelSignalProfile, TelegramChannel } from '../../types/database'

const DEFAULT_CHANNEL_KEYWORDS: ChannelKeywords = {
  signal: {
    entry_point: 'ENTRY',
    buy: 'BUY',
    sell: 'SELL',
    sl: 'SL',
    tp: 'TP',
    market_order: 'MARKET',
  },
  update: {
    close_tp1: 'CLOSE TP1',
    close_tp2: 'CLOSE TP2',
    close_tp3: 'CLOSE TP3',
    close_tp4: 'CLOSE TP4',
    close_full: 'CLOSE FULL',
    close_half: 'CLOSE HALF',
    close_partial: 'CLOSE PARTIAL',
    break_even: 'BREAK EVEN',
    set_tp1: 'SET TP1',
    set_tp2: 'SET TP2',
    set_tp3: 'SET TP3',
    set_tp4: 'SET TP4',
    set_tp5: 'SET TP5',
    set_tp: 'SET TP',
    set_sl: 'SET SL',
    delete: 'DELETE',
  },
  additional: {
    layer: 'LAYER',
    close_all: 'CLOSE ALL',
    delete_all: 'DELETE ALL',
    ignore_keyword: 'IGNORE',
    skip_keyword: 'SKIP',
    remove_sl: 'REMOVE SL',
    delay_msec: 0,
    prefer_entry: 'first_price',
    sl_in_pips: false,
    tp_in_pips: false,
    delimiters: '',
    all_order: false,
    read_forwarded: true,
    read_image: false,
  },
}

function normalizeChannelKeywords(raw: unknown): ChannelKeywords {
  const j = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const signal = j.signal && typeof j.signal === 'object' ? j.signal as Record<string, unknown> : {}
  const update = j.update && typeof j.update === 'object' ? j.update as Record<string, unknown> : {}
  const additional = j.additional && typeof j.additional === 'object' ? j.additional as Record<string, unknown> : {}
  return {
    signal: {
      entry_point: String(signal.entry_point ?? DEFAULT_CHANNEL_KEYWORDS.signal.entry_point),
      buy: String(signal.buy ?? DEFAULT_CHANNEL_KEYWORDS.signal.buy),
      sell: String(signal.sell ?? DEFAULT_CHANNEL_KEYWORDS.signal.sell),
      sl: String(signal.sl ?? DEFAULT_CHANNEL_KEYWORDS.signal.sl),
      tp: String(signal.tp ?? DEFAULT_CHANNEL_KEYWORDS.signal.tp),
      market_order: String(signal.market_order ?? DEFAULT_CHANNEL_KEYWORDS.signal.market_order),
    },
    update: {
      close_tp1: String(update.close_tp1 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp1),
      close_tp2: String(update.close_tp2 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp2),
      close_tp3: String(update.close_tp3 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp3),
      close_tp4: String(update.close_tp4 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp4),
      close_full: String(update.close_full ?? DEFAULT_CHANNEL_KEYWORDS.update.close_full),
      close_half: String(update.close_half ?? DEFAULT_CHANNEL_KEYWORDS.update.close_half),
      close_partial: String(update.close_partial ?? DEFAULT_CHANNEL_KEYWORDS.update.close_partial),
      break_even: String(update.break_even ?? DEFAULT_CHANNEL_KEYWORDS.update.break_even),
      set_tp1: String(update.set_tp1 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp1),
      set_tp2: String(update.set_tp2 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp2),
      set_tp3: String(update.set_tp3 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp3),
      set_tp4: String(update.set_tp4 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp4),
      set_tp5: String(update.set_tp5 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp5),
      set_tp: String(update.set_tp ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp),
      set_sl: String(update.set_sl ?? DEFAULT_CHANNEL_KEYWORDS.update.set_sl),
      delete: String(update.delete ?? DEFAULT_CHANNEL_KEYWORDS.update.delete),
    },
    additional: {
      layer: String(additional.layer ?? DEFAULT_CHANNEL_KEYWORDS.additional.layer),
      close_all: String(additional.close_all ?? DEFAULT_CHANNEL_KEYWORDS.additional.close_all),
      delete_all: String(additional.delete_all ?? DEFAULT_CHANNEL_KEYWORDS.additional.delete_all),
      ignore_keyword: String(additional.ignore_keyword ?? DEFAULT_CHANNEL_KEYWORDS.additional.ignore_keyword),
      skip_keyword: String(additional.skip_keyword ?? DEFAULT_CHANNEL_KEYWORDS.additional.skip_keyword),
      remove_sl: String(additional.remove_sl ?? DEFAULT_CHANNEL_KEYWORDS.additional.remove_sl),
      delay_msec: Number(additional.delay_msec ?? DEFAULT_CHANNEL_KEYWORDS.additional.delay_msec) || 0,
      prefer_entry: String(additional.prefer_entry ?? DEFAULT_CHANNEL_KEYWORDS.additional.prefer_entry) === 'last_price' ? 'last_price' : 'first_price',
      sl_in_pips: Boolean(additional.sl_in_pips ?? DEFAULT_CHANNEL_KEYWORDS.additional.sl_in_pips),
      tp_in_pips: Boolean(additional.tp_in_pips ?? DEFAULT_CHANNEL_KEYWORDS.additional.tp_in_pips),
      delimiters: String(additional.delimiters ?? DEFAULT_CHANNEL_KEYWORDS.additional.delimiters),
      all_order: Boolean(additional.all_order ?? DEFAULT_CHANNEL_KEYWORDS.additional.all_order),
      read_forwarded: Boolean(additional.read_forwarded ?? DEFAULT_CHANNEL_KEYWORDS.additional.read_forwarded),
      read_image: Boolean(additional.read_image ?? DEFAULT_CHANNEL_KEYWORDS.additional.read_image),
    },
  }
}

function getTelegramAvatarUrl(username?: string): string | null {
  if (!username) return null
  return `https://t.me/i/userpic/320/${username}.jpg`
}

function TgChannelAvatar({ title, username }: { title: string; username?: string }) {
  const [imageFailed, setImageFailed] = useState(false)
  const avatarUrl = getTelegramAvatarUrl(username)

  return (
    <div className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center flex-shrink-0 overflow-hidden">
      {avatarUrl && !imageFailed ? (
        <img
          src={avatarUrl}
          alt={`${title} avatar`}
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <img
          src="/Telegram.svg"
          alt="Telegram"
          className="w-5 h-5 object-contain"
          loading="lazy"
        />
      )}
    </div>
  )
}

export function CopierEnginePage() {
  const { user, session } = useAuth()
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [channelProfiles, setChannelProfiles] = useState<Record<string, ChannelSignalProfile>>({})
  const [analyzingChannels, setAnalyzingChannels] = useState<Set<string>>(new Set())
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, number>>({})
  const [tgChannels, setTgChannels] = useState<{ id: string; title: string; username: string; members_count: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingTg, setLoadingTg] = useState(false)
  const [tgChannelsCollapsed, setTgChannelsCollapsed] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newChannel, setNewChannel] = useState({ channel_id: '', channel_username: '', display_name: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [hasTgSession, setHasTgSession] = useState(false)
  const [tgStage, setTgStage] = useState<'idle' | 'phone' | 'code' | 'linked'>('idle')
  const [tgPhone, setTgPhone] = useState('')
  const [tgCode, setTgCode] = useState('')
  const [tgPassword, setTgPassword] = useState('')
  const [tgLoading, setTgLoading] = useState(false)
  const [tgError, setTgError] = useState('')
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [keywordsChannel, setKeywordsChannel] = useState<TelegramChannel | null>(null)
  const [keywordsDraft, setKeywordsDraft] = useState<ChannelKeywords>(DEFAULT_CHANNEL_KEYWORDS)
  const [keywordsSaving, setKeywordsSaving] = useState(false)

  const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`
  const EDGE_ANALYZE_PROFILE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-channel-profile`

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    const [channelsRes, sessionRes] = await Promise.all([
      supabase.from('telegram_channels').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }),
      supabase.from('telegram_sessions').select('id').eq('user_id', user!.id).maybeSingle(),
    ])
    setChannels((channelsRes.data ?? []) as TelegramChannel[])
    const channelRows = (channelsRes.data ?? []) as TelegramChannel[]
    void loadChannelProfiles(channelRows.map(c => c.id))
    const hasSession = !!sessionRes.data
    setHasTgSession(hasSession)
    setTgStage(hasSession ? 'linked' : 'idle')
    setLoading(false)
    if (hasSession) fetchTgChannels()
  }

  const loadChannelProfiles = async (channelIds: string[]) => {
    if (!channelIds.length) {
      setChannelProfiles({})
      return
    }
    const { data } = await supabase
      .from('channel_signal_profiles')
      .select('*')
      .in('channel_id', channelIds)
    const rows = (data ?? []) as ChannelSignalProfile[]
    const next: Record<string, ChannelSignalProfile> = {}
    for (const row of rows) next[row.channel_id] = row
    setChannelProfiles(next)
  }

  const analyzeChannelProfile = async (channelId: string) => {
    if (!session?.access_token) return
    setAnalyzingChannels(prev => {
      const next = new Set(prev)
      next.add(channelId)
      return next
    })
    setAnalysisProgress(prev => ({ ...prev, [channelId]: 0 }))
    try {
      setAnalysisProgress(prev => ({ ...prev, [channelId]: 10 }))
      let historicalMessages: string[] = []
      // Backfill last 30 days from Telegram before profiling so insights
      // are not limited to only recently ingested messages.
      const backfillRes = await fetch(EDGE_FN, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'backfill_channel_history', channel_row_id: channelId, days: 30 }),
      }).catch(() => null)
      if (backfillRes) {
        const backfillData = await backfillRes.json().catch(() => null)
        if (backfillRes.ok && Array.isArray(backfillData?.messages)) {
          historicalMessages = backfillData.messages as string[]
        }
      }

      setAnalysisProgress(prev => ({ ...prev, [channelId]: 60 }))
      const res = await fetch(EDGE_ANALYZE_PROFILE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel_id: channelId, lookback_days: 30, historical_messages: historicalMessages }),
      })
      setAnalysisProgress(prev => ({ ...prev, [channelId]: 85 }))
      const data = await res.json()
      if (!res.ok || !data?.profile) return
      const profile = data.profile as ChannelSignalProfile
      setChannelProfiles(prev => ({ ...prev, [channelId]: profile }))
      setAnalysisProgress(prev => ({ ...prev, [channelId]: 100 }))
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch {
      // non-blocking background enrichment
    } finally {
      setAnalyzingChannels(prev => {
        const next = new Set(prev)
        next.delete(channelId)
        return next
      })
      setAnalysisProgress(prev => {
        const next = { ...prev }
        delete next[channelId]
        return next
      })
    }
  }

  const fetchTgChannels = async () => {
    setLoadingTg(true)
    setError('')
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_channels' }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error || 'Failed to load Telegram channels')
        return
      }
      setTgChannels(data.channels ?? [])
    } catch {
      setError('Failed to load Telegram channels')
    } finally {
      setLoadingTg(false)
    }
  }

  const toggleChannel = async (id: string, is_active: boolean) => {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, is_active } : c))
    await supabase.from('telegram_channels').update({ is_active }).eq('id', id)
  }

  const deleteChannel = async (id: string) => {
    setChannels(prev => prev.filter(c => c.id !== id))
    await supabase.from('telegram_channels').delete().eq('id', id)
  }

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newChannel.display_name.trim()) { setError('Channel name is required'); return }
    setSaving(true)
    const { data, error: dbErr } = await supabase
      .from('telegram_channels')
      .insert({
        user_id: user!.id,
        channel_id: newChannel.channel_id.trim() || newChannel.channel_username.trim(),
        channel_username: newChannel.channel_username.trim().replace(/^@/, ''),
        display_name: newChannel.display_name.trim(),
        is_active: true,
      })
      .select('*')
      .single()
    setSaving(false)
    if (dbErr) { setError(dbErr.message); return }
    const inserted = data as TelegramChannel
    setChannels(prev => [inserted, ...prev])
    setNewChannel({ channel_id: '', channel_username: '', display_name: '' })
    setShowAdd(false)
    void analyzeChannelProfile(inserted.id)
  }

  const addFromTg = async (ch: { id: string; title: string; username: string }) => {
    setError('')
    const { data, error: dbErr } = await supabase
      .from('telegram_channels')
      .upsert({
        user_id: user!.id,
        channel_id: ch.id,
        channel_username: ch.username ?? '',
        display_name: ch.title,
        is_active: true,
      }, { onConflict: 'user_id,channel_id' })
      .select('*')
      .single()
    if (dbErr) {
      setError(dbErr.message)
      return
    }
    if (!dbErr && data) {
      const upserted = data as TelegramChannel
      setChannels(prev => {
        const exists = prev.find(c => c.channel_id === ch.id)
        return exists ? prev.map(c => c.channel_id === ch.id ? upserted : c) : [upserted, ...prev]
      })
      void analyzeChannelProfile(upserted.id)
    }
  }

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setTgError('')
    setTgLoading(true)
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'send_code', phone: tgPhone }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setTgError(data.error || 'Failed to send code')
        return
      }
      setTgStage('code')
    } catch {
      setTgError('Network error')
    } finally {
      setTgLoading(false)
    }
  }

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setTgError('')
    setTgLoading(true)
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify_code',
          phone: tgPhone,
          code: tgCode,
          password: requiresPassword ? tgPassword : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        if (data.requires_password) {
          setRequiresPassword(true)
          setTgError('Enter your Telegram 2FA password.')
          return
        }
        setTgError(data.error || 'Verification failed')
        return
      }
      await loadData()
    } catch {
      setTgError('Network error')
    } finally {
      setTgLoading(false)
    }
  }

  const disconnectTelegram = async () => {
    await supabase.from('telegram_sessions').delete().eq('user_id', user!.id)
    setHasTgSession(false)
    setTgStage('idle')
    setTgChannels([])
  }

  const openChannelKeywords = (channel: TelegramChannel) => {
    setKeywordsChannel(channel)
    setKeywordsDraft(normalizeChannelKeywords(channel.channel_keywords))
  }

  const closeChannelKeywords = () => {
    setKeywordsChannel(null)
  }

  const saveChannelKeywords = async () => {
    if (!keywordsChannel) return
    setKeywordsSaving(true)
    const { data, error } = await supabase
      .from('telegram_channels')
      .update({ channel_keywords: keywordsDraft })
      .eq('id', keywordsChannel.id)
      .select('*')
      .single()
    setKeywordsSaving(false)
    if (error) {
      setError(error.message)
      return
    }
    setChannels(prev => prev.map(c => c.id === keywordsChannel.id ? data as TelegramChannel : c))
    closeChannelKeywords()
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Channels</h1>
          <p className="text-sm text-neutral-500 mt-0.5">Configure which Telegram channels feed into the copier</p>
        </div>
        <div className="flex gap-2">
          {!hasTgSession && tgStage === 'idle' && (
            <Button size="sm" onClick={() => setTgStage('phone')}>
              Connect Telegram
            </Button>
          )}
          {hasTgSession && (
            <Button variant="secondary" size="sm" onClick={fetchTgChannels} loading={loadingTg}>
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {/* Status row */}
      {/* {brokers.length === 0 && (
        <div className="mb-4 px-4 py-3 bg-warning-50 border border-warning-200 rounded-xl text-sm text-warning-700 flex items-center gap-2">
          <span className="font-medium">No active broker account.</span>
          <a href="/account-configuration" className="underline text-warning-800">Connect one in Account Configuration.</a>
        </div>
      )} */}
      {!hasTgSession && tgStage === 'idle' && (
        <div className="mb-4 px-4 py-3 bg-warning-50 border border-warning-200 rounded-xl text-sm text-warning-700 flex items-center gap-2">
          <span className="font-medium">Telegram not connected.</span>
          <span>Connect Telegram here to load and manage your channel list.</span>
        </div>
      )}

      {!hasTgSession && tgStage !== 'idle' && (
        <Card className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center overflow-hidden">
              <img
                src="/Telegram.svg"
                alt="Telegram"
                className="w-4 h-4 object-contain"
                loading="lazy"
              />
            </div>
            <p className="text-sm font-semibold text-neutral-900">
              {tgStage === 'phone' ? 'Connect Telegram: enter your phone number' : 'Connect Telegram: enter verification code'}
            </p>
          </div>

          {tgError && (
            <div className="mb-3 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">{tgError}</div>
          )}

          {tgStage === 'phone' ? (
            <form onSubmit={sendCode} className="space-y-3">
              <Input
                label="Phone number"
                type="tel"
                placeholder="+1 234 567 8900"
                value={tgPhone}
                onChange={e => setTgPhone(e.target.value)}
                hint="Include country code"
                required
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" loading={tgLoading} size="sm">Send code</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setTgStage('idle')}>Cancel</Button>
              </div>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-3">
              <Input
                label="Verification code"
                placeholder="12345"
                value={tgCode}
                onChange={e => setTgCode(e.target.value)}
                hint={`Sent to ${tgPhone}`}
                required
                autoFocus
              />
              {requiresPassword && (
                <Input
                  label="2FA password"
                  type="password"
                  placeholder="Your Telegram password"
                  value={tgPassword}
                  onChange={e => setTgPassword(e.target.value)}
                  required
                />
              )}
              <div className="flex gap-2">
                <Button type="submit" loading={tgLoading} size="sm">Verify</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setTgStage('phone'); setTgError('') }}>Back</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {/* Telegram channels panel */}
      {hasTgSession && (
        <Card className="mb-4" padding="none">
          <div className="px-5 py-3 border-b border-neutral-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-neutral-900">Your Telegram channels</p>
              <Badge variant="success" size="sm">Connected</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTgChannelsCollapsed(prev => !prev)}
                className="text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${tgChannelsCollapsed ? '-rotate-90' : 'rotate-0'}`} />
                {tgChannelsCollapsed ? 'Expand' : 'Collapse'}
              </Button>
              <Button variant="ghost" size="sm" onClick={disconnectTelegram} className="text-error-600 hover:bg-error-50 hover:text-error-700">
                <AlertCircle className="w-3.5 h-3.5" />
                Disconnect
              </Button>
            {tgChannels.length > 0 && (
              <span className="text-xs text-neutral-400">{tgChannels.length} found</span>
            )}
            </div>
          </div>
          {!tgChannelsCollapsed && (loadingTg ? (
            <div className="divide-y divide-neutral-50">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-5 py-3 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-neutral-100 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-neutral-100 rounded animate-pulse w-48" />
                    <div className="h-2.5 bg-neutral-100 rounded animate-pulse w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-5 py-10 text-center">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-error-300" />
              <p className="text-sm text-error-600 font-medium">{error}</p>
              <p className="text-xs text-neutral-400 mt-0.5">Use Refresh after fixing Telegram connection or worker issues.</p>
            </div>
          ) : tgChannels.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <Radio className="w-8 h-8 mx-auto mb-2 text-neutral-200" />
              <p className="text-sm text-neutral-400">No channels or groups found</p>
              <p className="text-xs text-neutral-300 mt-0.5">Make sure you are a member of the signal channels</p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-50 max-h-72 overflow-y-auto">
              {tgChannels.map(ch => {
                const alreadyAdded = channels.some(c => c.channel_id === ch.id)
                return (
                  <div key={ch.id} className="px-5 py-3 flex items-center gap-3 hover:bg-neutral-50 transition-colors">
                    <TgChannelAvatar title={ch.title} username={ch.username} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 truncate">{ch.title}</p>
                      {ch.username && <p className="text-xs text-neutral-400">@{ch.username}</p>}
                    </div>
                    {ch.members_count > 0 && (
                      <span className="text-xs text-neutral-400 flex-shrink-0">{ch.members_count.toLocaleString()} members</span>
                    )}
                    <button
                      onClick={() => addFromTg(ch)}
                      className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors flex-shrink-0 ${
                        alreadyAdded
                          ? 'border-neutral-200 text-neutral-400 cursor-default'
                          : 'border-primary-500 text-primary-600 hover:bg-primary-50'
                      }`}
                      disabled={alreadyAdded}
                    >
                      {alreadyAdded ? 'Added' : 'Add'}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </Card>
      )}

      {/* Manual add form */}
      {showAdd && (
        <Card className="mb-4">
          <h3 className="text-sm font-semibold text-neutral-900 mb-4">Add channel manually</h3>
          {error && <div className="mb-3 px-3 py-2 bg-error-50 border border-error-200 rounded-lg text-sm text-error-700">{error}</div>}
          <form onSubmit={addManual} className="space-y-3">
            <Input label="Channel name" placeholder="e.g. Gold Signals Pro" value={newChannel.display_name} onChange={e => setNewChannel(p => ({ ...p, display_name: e.target.value }))} required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Username (optional)" placeholder="@channelname" value={newChannel.channel_username} onChange={e => setNewChannel(p => ({ ...p, channel_username: e.target.value }))} />
              <Input label="Channel ID (optional)" placeholder="Telegram channel ID" value={newChannel.channel_id} onChange={e => setNewChannel(p => ({ ...p, channel_id: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="submit" loading={saving} size="sm">Add channel</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}

      {/* Channel list */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-white rounded-xl border border-neutral-100 animate-pulse" />)}
        </div>
      ) : channels.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-neutral-200 py-16 text-center">
          <Radio className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
          <p className="text-sm font-medium text-neutral-400">No channels configured</p>
          <p className="text-xs text-neutral-300 mt-1">Add signal channels to start the copier</p>
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map(channel => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              profile={channelProfiles[channel.id]}
              isAnalyzing={analyzingChannels.has(channel.id)}
              analysisProgress={analysisProgress[channel.id] ?? 0}
              onToggle={v => toggleChannel(channel.id, v)}
              onDelete={() => deleteChannel(channel.id)}
              onKeywords={() => openChannelKeywords(channel)}
            />
          ))}
        </div>
      )}

      {keywordsChannel && (
        <div className="fixed inset-0 z-50 bg-black/40 px-4 flex items-center justify-center">
          <div className="w-full max-w-5xl max-h-[86vh] overflow-y-auto rounded-2xl bg-white border border-neutral-200 shadow-xl">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-neutral-900">Channel Keywords</h3>
                <p className="text-sm text-neutral-500 mt-0.5">{keywordsChannel.display_name}</p>
              </div>
              <button onClick={closeChannelKeywords} className="px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-700">Close</button>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700">Signal Keyword</p>
                <Input label="Entry Point" value={keywordsDraft.signal.entry_point} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, entry_point: e.target.value } }))} />
                <Input label="BUY" value={keywordsDraft.signal.buy} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, buy: e.target.value } }))} />
                <Input label="SELL" value={keywordsDraft.signal.sell} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, sell: e.target.value } }))} />
                <Input label="SL" value={keywordsDraft.signal.sl} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, sl: e.target.value } }))} />
                <Input label="TP" value={keywordsDraft.signal.tp} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, tp: e.target.value } }))} />
                <Input label="Market Order" value={keywordsDraft.signal.market_order} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, market_order: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700">Update Keyword</p>
                <Input label="Close TP1" value={keywordsDraft.update.close_tp1} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp1: e.target.value } }))} />
                <Input label="Close TP2" value={keywordsDraft.update.close_tp2} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp2: e.target.value } }))} />
                <Input label="Close TP3" value={keywordsDraft.update.close_tp3} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp3: e.target.value } }))} />
                <Input label="Close TP4" value={keywordsDraft.update.close_tp4} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp4: e.target.value } }))} />
                <Input label="Close Full" value={keywordsDraft.update.close_full} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_full: e.target.value } }))} />
                <Input label="Close Half" value={keywordsDraft.update.close_half} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_half: e.target.value } }))} />
                <Input label="Close Partial" value={keywordsDraft.update.close_partial} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_partial: e.target.value } }))} />
                <Input label="Break Even" value={keywordsDraft.update.break_even} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, break_even: e.target.value } }))} />
                <Input label="Set TP1" value={keywordsDraft.update.set_tp1} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp1: e.target.value } }))} />
                <Input label="Set TP2" value={keywordsDraft.update.set_tp2} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp2: e.target.value } }))} />
                <Input label="Set TP3" value={keywordsDraft.update.set_tp3} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp3: e.target.value } }))} />
                <Input label="Set TP4" value={keywordsDraft.update.set_tp4} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp4: e.target.value } }))} />
                <Input label="Set TP5" value={keywordsDraft.update.set_tp5} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp5: e.target.value } }))} />
                <Input label="Set TP" value={keywordsDraft.update.set_tp} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp: e.target.value } }))} />
                <Input label="Set SL" value={keywordsDraft.update.set_sl} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_sl: e.target.value } }))} />
                <Input label="Delete" value={keywordsDraft.update.delete} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, delete: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700">Additional Keyword</p>
                <Input label="Layer" value={keywordsDraft.additional.layer} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, layer: e.target.value } }))} />
                <Input label="Close All" value={keywordsDraft.additional.close_all} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, close_all: e.target.value } }))} />
                <Input label="Delete All" value={keywordsDraft.additional.delete_all} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delete_all: e.target.value } }))} />
                <Input label="Ignore Keyword" value={keywordsDraft.additional.ignore_keyword} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, ignore_keyword: e.target.value } }))} />
                <Input label="Skip Keyword" value={keywordsDraft.additional.skip_keyword} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, skip_keyword: e.target.value } }))} />
                <Input label="Remove SL" value={keywordsDraft.additional.remove_sl} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, remove_sl: e.target.value } }))} />
                <Input label="Delay in Msec" type="number" value={String(keywordsDraft.additional.delay_msec)} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delay_msec: Number(e.target.value) } }))} />
                <Select label="Prefer Entry" value={keywordsDraft.additional.prefer_entry} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, prefer_entry: e.target.value as 'first_price' | 'last_price' } }))} options={[{ value: 'first_price', label: 'First Price' }, { value: 'last_price', label: 'Last Price' }]} />
                <Select label="SL In Pips" value={keywordsDraft.additional.sl_in_pips ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, sl_in_pips: e.target.value === 'true' } }))} options={[{ value: 'false', label: 'False' }, { value: 'true', label: 'True' }]} />
                <Select label="TP In Pips" value={keywordsDraft.additional.tp_in_pips ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, tp_in_pips: e.target.value === 'true' } }))} options={[{ value: 'false', label: 'False' }, { value: 'true', label: 'True' }]} />
                <Input label="Delimiters" value={keywordsDraft.additional.delimiters} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delimiters: e.target.value } }))} />
                <Select label="ALL Order" value={keywordsDraft.additional.all_order ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, all_order: e.target.value === 'true' } }))} options={[{ value: 'false', label: 'False' }, { value: 'true', label: 'True' }]} />
                <Select label="Read Forwarded" value={keywordsDraft.additional.read_forwarded ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, read_forwarded: e.target.value === 'true' } }))} options={[{ value: 'false', label: 'False' }, { value: 'true', label: 'True' }]} />
                <Select label="Read Image" value={keywordsDraft.additional.read_image ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, read_image: e.target.value === 'true' } }))} options={[{ value: 'false', label: 'False' }, { value: 'true', label: 'True' }]} />
              </div>
            </div>
            <div className="px-5 py-4 border-t border-neutral-100 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeChannelKeywords} disabled={keywordsSaving}>Cancel</Button>
              <Button loading={keywordsSaving} onClick={() => void saveChannelKeywords()}>Save Keywords</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ChannelRow({
  channel, profile, isAnalyzing, analysisProgress, onToggle, onDelete, onKeywords,
}: {
  channel: TelegramChannel
  profile?: ChannelSignalProfile
  isAnalyzing: boolean
  analysisProgress: number
  onToggle: (v: boolean) => void
  onDelete: () => void
  onKeywords: () => void
}) {
  return (
    <div className="bg-white rounded-xl border border-neutral-100 shadow-card overflow-hidden">
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0">
          <Radio className="w-4 h-4 text-primary-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-neutral-900">{channel.display_name}</p>
            {!channel.is_active && <Badge variant="neutral" size="sm">Paused</Badge>}
          </div>
          {channel.channel_username && <p className="text-xs text-neutral-400 mt-0.5">@{channel.channel_username}</p>}
          <div className="mt-2 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
            <p className="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">AI Analysis</p>
            {isAnalyzing ? (
              <div className="mt-1.5">
                <p className="text-xs text-neutral-500 mb-1.5">
                  Analyzing Signals for the last 30 days... {Math.max(0, Math.min(100, Math.round(analysisProgress)))}%
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div
                    className="h-full rounded-full bg-primary-500 transition-all duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, analysisProgress))}%` }}
                  />
                </div>
              </div>
            ) : !profile ? (
              <p className="text-xs text-neutral-400 mt-1">No insights yet. Insights will be generated automatically when this channel is added.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <Badge variant="neutral" size="sm">Type: {profile.signal_type}</Badge>
                  <Badge variant="neutral" size="sm">Entry: {profile.entry_type}</Badge>
                  <Badge variant="neutral" size="sm">TP: {profile.tp_style}</Badge>
                  <Badge variant="neutral" size="sm">SL: {profile.sl_style}</Badge>
                </div>
                {profile.analysis_summary && (
                  <p className="text-[11px] text-neutral-400 mt-0.5">{profile.analysis_summary}</p>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Toggle checked={channel.is_active} onChange={onToggle} />
          <button onClick={onKeywords} className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors">
            <Settings className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="p-1.5 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
