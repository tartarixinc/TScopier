import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Radio, Trash2, RefreshCw, CircleAlert as AlertCircle, ChevronDown, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import {
  brokersMatchingChannel,
  brokersNotMatchingChannel,
  connectChannelToBroker,
  getBrokerDisplayLabel,
  reconcileBrokerChannelLinks,
} from '../../lib/brokerChannelLink'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Toggle } from '../../components/ui/Toggle'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { TelegramConnectFlow, type TelegramConnectStage } from '../../components/telegram/TelegramConnectFlow'
import {
  getCachedTgChannels,
  invalidateTgChannelsCache,
  setCachedTgChannels,
  type TgChannelListItem,
} from '../../lib/telegramChannelsCache'
import type { BrokerAccount, ChannelKeywords, ChannelSignalProfile, TelegramChannel } from '../../types/database'

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
    adjust_tp: 'ADJUST TP',
    set_sl: 'SET SL',
    adjust_sl: 'ADJUST SL',
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
      adjust_tp: String(update.adjust_tp ?? DEFAULT_CHANNEL_KEYWORDS.update.adjust_tp),
      set_sl: String(update.set_sl ?? DEFAULT_CHANNEL_KEYWORDS.update.set_sl),
      adjust_sl: String(update.adjust_sl ?? DEFAULT_CHANNEL_KEYWORDS.update.adjust_sl),
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

function channelNeedsProfiling(profile: ChannelSignalProfile | undefined): boolean {
  if (!profile) return true
  const meta =
    profile.meta && typeof profile.meta === 'object' && !Array.isArray(profile.meta)
      ? (profile.meta as Record<string, unknown>)
      : {}
  if (meta.profiling === 'disabled' || meta.keywords_only === true) return false
  if (profile.sample_size > 0) return false
  if (profile.signal_type !== 'unknown') return false
  return true
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
  const t = useT()
  const ce = t.copierEnginePage
  const ch = t.channelsPage
  const { user, session } = useAuth()
  const initialTgCache = user?.id ? getCachedTgChannels(user.id) : null
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [connectMenuChannelId, setConnectMenuChannelId] = useState<string | null>(null)
  const [connectingBrokerId, setConnectingBrokerId] = useState<string | null>(null)
  const [channelProfiles, setChannelProfiles] = useState<Record<string, ChannelSignalProfile>>({})
  const [analyzingChannels, setAnalyzingChannels] = useState<Set<string>>(new Set())
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, number>>({})
  const [tgChannels, setTgChannels] = useState<TgChannelListItem[]>(initialTgCache ?? [])
  const [loading, setLoading] = useState(true)
  const [loadingTg, setLoadingTg] = useState(false)
  const [tgChannelsCollapsed, setTgChannelsCollapsed] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newChannel, setNewChannel] = useState({ channel_id: '', channel_username: '', display_name: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tgChannelSearch, setTgChannelSearch] = useState('')
  const [hasTgSession, setHasTgSession] = useState(false)
  const [tgStage, setTgStage] = useState<'idle' | 'phone' | 'code' | 'twoFa' | 'linked'>('idle')
  const [tgPhone, setTgPhone] = useState('')
  const [tgCode, setTgCode] = useState('')
  const [tgPassword, setTgPassword] = useState('')
  const [tgLoading, setTgLoading] = useState(false)
  const [tgError, setTgError] = useState('')
  const [keywordsChannel, setKeywordsChannel] = useState<TelegramChannel | null>(null)
  const [keywordsDraft, setKeywordsDraft] = useState<ChannelKeywords>(DEFAULT_CHANNEL_KEYWORDS)
  const [keywordsSaving, setKeywordsSaving] = useState(false)

  const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`
  const EDGE_ANALYZE_PROFILE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-channel-profile`

  useEffect(() => {
    if (!user) return
    const cached = getCachedTgChannels(user.id)
    if (cached) setTgChannels(cached)
    void loadData({ skipTgFetch: Boolean(cached) })
  }, [user])

  const loadData = async (opts?: { skipTgFetch?: boolean; backgroundTgFetch?: boolean; forceTgFetch?: boolean }) => {
    const [channelsRes, sessionRes, brokersRes] = await Promise.all([
      supabase.from('telegram_channels').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }),
      supabase.from('telegram_sessions').select('id').eq('user_id', user!.id).maybeSingle(),
      supabase.from('broker_accounts').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }),
    ])
    const channelRows = (channelsRes.data ?? []) as TelegramChannel[]
    setChannels(channelRows)
    void loadChannelProfiles(channelRows)
    const brokerRows = (brokersRes.data ?? []) as BrokerAccount[]
    const reconciled = await reconcileBrokerChannelLinks(supabase, user!.id, channelRows, brokerRows)
    setBrokers(reconciled)
    const hasSession = !!sessionRes.data
    setHasTgSession(hasSession)
    setTgStage(hasSession ? 'linked' : 'idle')
    setLoading(false)
    if (hasSession && !opts?.skipTgFetch) {
      const cached = user?.id ? getCachedTgChannels(user.id) : null
      if (cached && !opts?.forceTgFetch) {
        setTgChannels(cached)
      } else {
        void fetchTgChannels({
          background: opts?.backgroundTgFetch ?? Boolean(cached),
          force: opts?.forceTgFetch,
        })
      }
    }
  }

  const loadChannelProfiles = async (channelRows: TelegramChannel[]) => {
    const channelIds = channelRows.map(c => c.id)
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

  const analyzeChannelProfile = useCallback(async (channelId: string) => {
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
  }, [session?.access_token])

  /** Remove Telegram session only (manual disconnect). Keeps configured channels. */
  const clearTelegramConnection = useCallback(async (nextStage: 'idle' | 'phone') => {
    if (!user?.id) return
    await supabase.from('telegram_sessions').delete().eq('user_id', user.id)
    setHasTgSession(false)
    setTgChannels([])
    setTgChannelSearch('')
    if (user.id) invalidateTgChannelsCache(user.id)
    setTgError('')
    setError('')
    setTgCode('')
    setTgPassword('')
    setTgStage(nextStage)
  }, [user])

  /** Open phone → code flow without removing configured channels. */
  const reconnectTelegram = useCallback(async () => {
    setTgError('')
    setTgCode('')
    setTgPassword('')
    setTgStage('phone')
  }, [])

  /** Session revoked server-side — show reconnect UI; never wipe configured channels. */
  const handleTelegramSessionInvalid = useCallback(async () => {
    if (!user?.id) return
    setHasTgSession(false)
    setTgChannels([])
    setTgChannelSearch('')
    invalidateTgChannelsCache(user.id)
    setTgError(ce.telegramSessionExpired)
    const { data: channelRows } = await supabase
      .from('telegram_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    setChannels((channelRows ?? []) as TelegramChannel[])
    setTgStage('phone')
  }, [user, ce.telegramSessionExpired])

  const fetchTgChannels = async (opts?: { background?: boolean; force?: boolean }) => {
    if (!opts?.force && user?.id) {
      const cached = getCachedTgChannels(user.id)
      if (cached) {
        setTgChannels(cached)
        return
      }
    }
    setLoadingTg(true)
    if (!opts?.background) setError('')
    const maxAttempts = 3
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 1500 * attempt))
        }
        try {
          const res = await fetch(EDGE_FN, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list_channels' }),
          })
          const data = await res.json().catch(() => ({}))
          if (data.code === 'TELEGRAM_SESSION_INVALID') {
            await handleTelegramSessionInvalid()
            return
          }
          if (res.status === 401) {
            if (!opts?.background) {
              const msg = typeof data.error === 'string' ? data.error : ce.failedLoadTgChannels
              setError(msg)
            }
            return
          }
          if (!res.ok || data.error) {
            if (attempt < maxAttempts - 1) continue
            if (!opts?.background) {
              const msg = typeof data.error === 'string' ? data.error : ce.failedLoadTgChannels
              setError(msg)
            }
            return
          }
          const list = (data.channels ?? []) as TgChannelListItem[]
          setTgChannels(list)
          if (user?.id) setCachedTgChannels(user.id, list)
          if (!opts?.background) setError('')
          return
        } catch {
          if (attempt >= maxAttempts - 1 && !opts?.background) {
            setError(ce.failedLoadTgChannels)
          }
        }
      }
    } finally {
      setLoadingTg(false)
    }
  }

  const filteredTgChannels = useMemo(() => {
    const q = tgChannelSearch.trim().toLowerCase()
    if (!q) return tgChannels
    return tgChannels.filter(ch => {
      const title = (ch.title ?? '').toLowerCase()
      const user = (ch.username ?? '').toLowerCase().replace(/^@/, '')
      return title.includes(q) || user.includes(q) || `@${user}`.includes(q)
    })
  }, [tgChannels, tgChannelSearch])

  const toggleChannel = async (id: string, is_active: boolean) => {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, is_active } : c))
    await supabase.from('telegram_channels').update({ is_active }).eq('id', id)
    if (is_active && channelNeedsProfiling(channelProfiles[id])) {
      void analyzeChannelProfile(id)
    }
  }

  const deleteChannel = async (id: string) => {
    setChannels(prev => prev.filter(c => c.id !== id))
    await supabase.from('telegram_channels').delete().eq('id', id)
  }

  const handleConnectChannelToBroker = async (channelId: string, brokerId: string) => {
    if (!user) return
    const broker = brokers.find(b => b.id === brokerId)
    if (!broker) return
    setConnectingBrokerId(brokerId)
    setError('')
    const { broker: updated, error: linkErr } = await connectChannelToBroker(
      supabase,
      user.id,
      broker,
      channelId,
      channels,
    )
    setConnectingBrokerId(null)
    if (linkErr) {
      setError(linkErr)
      return
    }
    if (updated) {
      setBrokers(prev => prev.map(b => (b.id === brokerId ? updated : b)))
    }
    setConnectMenuChannelId(null)
  }

  const linkChannelAfterAdd = async (channelRows: TelegramChannel[]) => {
    if (!user || !channelRows.length) return
    const reconciled = await reconcileBrokerChannelLinks(supabase, user.id, channelRows, brokers)
    setBrokers(reconciled)
  }

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newChannel.display_name.trim()) { setError(ch.nameRequired); return }
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
    const nextChannels = [inserted, ...channels]
    setChannels(prev => [inserted, ...prev])
    setNewChannel({ channel_id: '', channel_username: '', display_name: '' })
    setShowAdd(false)
    void analyzeChannelProfile(inserted.id)
    void linkChannelAfterAdd(nextChannels)
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
      const exists = channels.find(c => c.channel_id === ch.id)
      const nextChannels = exists
        ? channels.map(c => c.channel_id === ch.id ? upserted : c)
        : [upserted, ...channels]
      setChannels(prev => {
        const prevExists = prev.find(c => c.channel_id === ch.id)
        return prevExists ? prev.map(c => c.channel_id === ch.id ? upserted : c) : [upserted, ...prev]
      })
      void analyzeChannelProfile(upserted.id)
      void linkChannelAfterAdd(nextChannels)
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
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        setTgError(ce.failedSendCode)
        return
      }
      setTgStage('code')
    } catch {
      setTgError(ce.networkError)
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
          password: tgStage === 'twoFa' ? tgPassword : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.requires_password) {
        setTgStage('twoFa')
        setTgError('')
        return
      }
      if (!res.ok || data.error) {
        const msg = typeof data.error === 'string' ? data.error : ce.verificationFailed
        setTgError(msg)
        return
      }
      if (Array.isArray(data.channels)) {
        const list = data.channels as TgChannelListItem[]
        setTgChannels(list)
        if (user?.id) setCachedTgChannels(user.id, list)
        await loadData({ skipTgFetch: true })
      } else {
        await loadData()
      }
    } catch {
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }

  const disconnectTelegram = async () => {
    await clearTelegramConnection('idle')
  }

  const handleTgStageChange = (stage: TelegramConnectStage) => {
    setTgStage(stage)
    setTgError('')
    if (stage === 'phone') {
      setTgCode('')
      setTgPassword('')
    }
    if (stage === 'code') {
      setTgPassword('')
    }
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

  const sk = ce.signalKeywords
  const uk = ce.updateKeywords
  const ak = ce.additionalKeywords
  const boolSelectOptions = [
    { value: 'false', label: t.common.no },
    { value: 'true', label: t.common.yes },
  ]
  const entrySelectOptions = [
    { value: 'first_price', label: ak.firstPrice },
    { value: 'last_price', label: ak.lastPrice },
  ]

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.pages.copierEngine.title}
        subtitle={t.pages.copierEngine.description}
        actions={
          hasTgSession ? (
            <Button variant="secondary" size="sm" onClick={() => void fetchTgChannels({ force: true })} loading={loadingTg}>
              <RefreshCw className="w-3.5 h-3.5" />
              {t.common.refresh}
            </Button>
          ) : undefined
        }
      />

      {/* Status row */}
      {/* {brokers.length === 0 && (
        <div className="mb-4 px-4 py-3 bg-warning-50 border border-warning-200 rounded-xl text-sm text-warning-700 flex items-center gap-2">
          <span className="font-medium">No active broker account.</span>
          <a href="/account-configuration" className="underline text-warning-800">Connect one in Account Configuration.</a>
        </div>
      )} */}
      {!hasTgSession && (
        <TelegramConnectFlow
          stage={tgStage === 'linked' ? 'idle' : tgStage}
          onStageChange={handleTgStageChange}
          phone={tgPhone}
          onPhoneChange={setTgPhone}
          code={tgCode}
          onCodeChange={setTgCode}
          password={tgPassword}
          onPasswordChange={setTgPassword}
          loading={tgLoading}
          error={tgError}
          onSendCode={sendCode}
          onVerifyCode={verifyCode}
        />
      )}


      {/* Telegram channels panel */}
      {hasTgSession && (
        <Card className="mb-3" padding="none">
          <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-2 bg-gradient-to-r from-[#229ED9]/8 to-transparent dark:from-[#229ED9]/15">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-100 dark:border-neutral-700 flex items-center justify-center flex-shrink-0 shadow-sm">
                <img src="/Telegram.svg" alt="" className="w-[18px] h-[18px] object-contain" loading="lazy" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{ce.yourTelegramChannels}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{ce.telegramConnectedHint}</p>
              </div>
              <span className="flex-shrink-0 hidden sm:inline-flex">
                <Badge variant="success" size="sm">{ce.connected}</Badge>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTgChannelsCollapsed(prev => !prev)}
                className="text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800 hover:text-neutral-700 dark:text-neutral-300"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${tgChannelsCollapsed ? '-rotate-90' : 'rotate-0'}`} />
                {tgChannelsCollapsed ? ce.expand : ce.collapse}
              </Button>
              <Button variant="ghost" size="sm" onClick={disconnectTelegram} className="text-error-600 hover:bg-error-50 hover:text-error-700">
                <AlertCircle className="w-3.5 h-3.5" />
                {ce.disconnect}
              </Button>
            {tgChannels.length > 0 && (
              <span className="text-xs text-neutral-400">
                {interpolate(ce.channelsFound, { count: String(tgChannels.length) })}
              </span>
            )}
            </div>
          </div>
          {!tgChannelsCollapsed && tgChannels.length > 0 && (
            <div className="px-4 py-2 border-b border-neutral-100 dark:border-neutral-800">
              <Input
                type="search"
                placeholder={ce.channelSearchPlaceholder}
                value={tgChannelSearch}
                onChange={e => setTgChannelSearch(e.target.value)}
                aria-label={ce.channelSearchPlaceholder}
              />
            </div>
          )}
          {!tgChannelsCollapsed && (loadingTg && tgChannels.length === 0 ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-48" />
                    <div className="h-2.5 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-error-300" />
              <p className="text-sm text-neutral-700 dark:text-neutral-300 font-medium">{error}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => void fetchTgChannels({ force: true })} loading={loadingTg}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t.common.refresh}
                </Button>
                <Button size="sm" onClick={() => void reconnectTelegram()}>
                  {ce.reconnectTelegram}
                </Button>
              </div>
            </div>
          ) : tgChannels.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Radio className="w-8 h-8 mx-auto mb-2 text-neutral-200" />
              <p className="text-sm text-neutral-400">{ce.noTgChannelsTitle}</p>
              <p className="text-xs text-neutral-300 mt-0.5">{ce.noTgChannelsSubtitle}</p>
            </div>
          ) : filteredTgChannels.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-neutral-400">{ce.noChannelSearchResults}</p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-72 overflow-y-auto">
              {filteredTgChannels.map(ch => {
                const alreadyAdded = channels.some(c => c.channel_id === ch.id)
                return (
                  <div key={ch.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
                    <TgChannelAvatar title={ch.title} username={ch.username} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{ch.title}</p>
                      {ch.username && <p className="text-xs text-neutral-400">@{ch.username}</p>}
                    </div>
                    {ch.members_count > 0 && (
                      <span className="text-xs text-neutral-400 flex-shrink-0">
                        {interpolate(ce.members, { count: ch.members_count.toLocaleString() })}
                      </span>
                    )}
                    <button
                      onClick={() => addFromTg(ch)}
                      className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors flex-shrink-0 ${
                        alreadyAdded
                          ? 'border-neutral-200 dark:border-neutral-800 text-neutral-400 cursor-default'
                          : 'border-primary-500 text-primary-600 hover:bg-primary-50'
                      }`}
                      disabled={alreadyAdded}
                    >
                      {alreadyAdded ? ce.added : ce.add}
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
        <Card className="mb-3">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-3">{ch.addFormTitle}</h3>
          {error && <Alert className="mb-3">{error}</Alert>}
          <form onSubmit={addManual} className="space-y-3">
            <Input label={ch.channelName} placeholder={ch.channelNamePlaceholder} value={newChannel.display_name} onChange={e => setNewChannel(p => ({ ...p, display_name: e.target.value }))} required />
            <div className="grid grid-cols-2 gap-3">
              <Input label={ch.usernameOptional} placeholder={ch.usernamePlaceholder} value={newChannel.channel_username} onChange={e => setNewChannel(p => ({ ...p, channel_username: e.target.value }))} />
              <Input label={ch.channelIdOptional} placeholder={ch.channelIdPlaceholder} value={newChannel.channel_id} onChange={e => setNewChannel(p => ({ ...p, channel_id: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="submit" loading={saving} size="sm">{ch.addChannel}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>{t.common.cancel}</Button>
            </div>
          </form>
        </Card>
      )}

      {/* Channel list */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-14 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-100 dark:border-neutral-800 animate-pulse" />)}
        </div>
      ) : channels.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-10 text-center">
          <Radio className="w-8 h-8 mx-auto mb-2 text-neutral-200" />
          <p className="text-sm font-medium text-neutral-400">{ce.configuredEmptyTitle}</p>
          <p className="text-xs text-neutral-300 mt-0.5 max-w-sm mx-auto">
            {!hasTgSession ? ce.configuredEmptyConnectHint : ce.configuredEmptySubtitle}
          </p>
        </div>
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{ce.activeChannels}</p>
            <span className="text-xs text-neutral-400">
              {interpolate(ce.configuredCount, { count: String(channels.length) })}
            </span>
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {channels.map(channel => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                profile={channelProfiles[channel.id]}
                isAnalyzing={analyzingChannels.has(channel.id)}
                analysisProgress={analysisProgress[channel.id] ?? 0}
                brokers={brokers}
                connectMenuOpen={connectMenuChannelId === channel.id}
                connectingBrokerId={connectingBrokerId}
                onToggleConnectMenu={() => setConnectMenuChannelId(
                  connectMenuChannelId === channel.id ? null : channel.id,
                )}
                onCloseConnectMenu={() => setConnectMenuChannelId(null)}
                onConnectBroker={brokerId => void handleConnectChannelToBroker(channel.id, brokerId)}
                onToggle={v => toggleChannel(channel.id, v)}
                onDelete={() => deleteChannel(channel.id)}
                onKeywords={() => openChannelKeywords(channel)}
              />
            ))}
          </div>
        </Card>
      )}

      {keywordsChannel && (
        <div className="fixed inset-0 z-50 bg-black/40 px-4 flex items-center justify-center">
          <div className="w-full max-w-5xl max-h-[86vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl">
            <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{ce.keywordsTitle}</h3>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{keywordsChannel.display_name}</p>
              </div>
              <button onClick={closeChannelKeywords} className="px-3 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300">{ce.keywordsClose}</button>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{ce.signalKeywordSection}</p>
                <Input label={sk.entryPoint} value={keywordsDraft.signal.entry_point} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, entry_point: e.target.value } }))} />
                <Input label={sk.buy} value={keywordsDraft.signal.buy} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, buy: e.target.value } }))} />
                <Input label={sk.sell} value={keywordsDraft.signal.sell} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, sell: e.target.value } }))} />
                <Input label={sk.sl} value={keywordsDraft.signal.sl} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, sl: e.target.value } }))} />
                <Input label={sk.tp} value={keywordsDraft.signal.tp} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, tp: e.target.value } }))} />
                <Input label={sk.marketOrder} value={keywordsDraft.signal.market_order} onChange={e => setKeywordsDraft(p => ({ ...p, signal: { ...p.signal, market_order: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{ce.updateKeywordSection}</p>
                <Input label={uk.closeTp1} value={keywordsDraft.update.close_tp1} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp1: e.target.value } }))} />
                <Input label={uk.closeTp2} value={keywordsDraft.update.close_tp2} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp2: e.target.value } }))} />
                <Input label={uk.closeTp3} value={keywordsDraft.update.close_tp3} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp3: e.target.value } }))} />
                <Input label={uk.closeTp4} value={keywordsDraft.update.close_tp4} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_tp4: e.target.value } }))} />
                <Input label={uk.closeFull} value={keywordsDraft.update.close_full} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_full: e.target.value } }))} />
                <Input label={uk.closeHalf} value={keywordsDraft.update.close_half} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_half: e.target.value } }))} />
                <Input label={uk.closePartial} value={keywordsDraft.update.close_partial} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, close_partial: e.target.value } }))} />
                <Input label={uk.breakEven} value={keywordsDraft.update.break_even} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, break_even: e.target.value } }))} />
                <Input label={uk.setTp1} value={keywordsDraft.update.set_tp1} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp1: e.target.value } }))} />
                <Input label={uk.setTp2} value={keywordsDraft.update.set_tp2} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp2: e.target.value } }))} />
                <Input label={uk.setTp3} value={keywordsDraft.update.set_tp3} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp3: e.target.value } }))} />
                <Input label={uk.setTp4} value={keywordsDraft.update.set_tp4} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp4: e.target.value } }))} />
                <Input label={uk.setTp5} value={keywordsDraft.update.set_tp5} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp5: e.target.value } }))} />
                <Input label={uk.setTp} value={keywordsDraft.update.set_tp} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_tp: e.target.value } }))} />
                <Input label={uk.adjustTp} value={keywordsDraft.update.adjust_tp} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, adjust_tp: e.target.value } }))} />
                <Input label={uk.setSl} value={keywordsDraft.update.set_sl} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, set_sl: e.target.value } }))} />
                <Input label={uk.adjustSl} value={keywordsDraft.update.adjust_sl} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, adjust_sl: e.target.value } }))} />
                <Input label={uk.delete} value={keywordsDraft.update.delete} onChange={e => setKeywordsDraft(p => ({ ...p, update: { ...p.update, delete: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{ce.additionalKeywordSection}</p>
                <Input label={ak.layer} value={keywordsDraft.additional.layer} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, layer: e.target.value } }))} />
                <Input label={ak.closeAll} value={keywordsDraft.additional.close_all} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, close_all: e.target.value } }))} />
                <Input label={ak.deleteAll} value={keywordsDraft.additional.delete_all} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delete_all: e.target.value } }))} />
                <Input label={ak.ignoreKeyword} value={keywordsDraft.additional.ignore_keyword} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, ignore_keyword: e.target.value } }))} />
                <Input label={ak.skipKeyword} value={keywordsDraft.additional.skip_keyword} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, skip_keyword: e.target.value } }))} />
                <Input label={ak.removeSl} value={keywordsDraft.additional.remove_sl} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, remove_sl: e.target.value } }))} />
                <Input label={ak.delayMsec} type="number" value={String(keywordsDraft.additional.delay_msec)} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delay_msec: Number(e.target.value) } }))} />
                <Select label={ak.preferEntry} value={keywordsDraft.additional.prefer_entry} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, prefer_entry: e.target.value as 'first_price' | 'last_price' } }))} options={entrySelectOptions} />
                <Select label={ak.slInPips} value={keywordsDraft.additional.sl_in_pips ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, sl_in_pips: e.target.value === 'true' } }))} options={boolSelectOptions} />
                <Select label={ak.tpInPips} value={keywordsDraft.additional.tp_in_pips ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, tp_in_pips: e.target.value === 'true' } }))} options={boolSelectOptions} />
                <Input label={ak.delimiters} value={keywordsDraft.additional.delimiters} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, delimiters: e.target.value } }))} />
                <Select label={ak.allOrder} value={keywordsDraft.additional.all_order ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, all_order: e.target.value === 'true' } }))} options={boolSelectOptions} />
                <Select label={ak.readForwarded} value={keywordsDraft.additional.read_forwarded ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, read_forwarded: e.target.value === 'true' } }))} options={boolSelectOptions} />
                <Select label={ak.readImage} value={keywordsDraft.additional.read_image ? 'true' : 'false'} onChange={e => setKeywordsDraft(p => ({ ...p, additional: { ...p.additional, read_image: e.target.value === 'true' } }))} options={boolSelectOptions} />
              </div>
            </div>
            <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeChannelKeywords} disabled={keywordsSaving}>{t.common.cancel}</Button>
              <Button loading={keywordsSaving} onClick={() => void saveChannelKeywords()}>{ce.keywordsSave}</Button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}

function ChannelRow({
  channel, profile, isAnalyzing, analysisProgress, brokers,
  connectMenuOpen, connectingBrokerId, onToggleConnectMenu, onCloseConnectMenu, onConnectBroker,
  onToggle, onDelete,
}: {
  channel: TelegramChannel
  profile?: ChannelSignalProfile
  isAnalyzing: boolean
  analysisProgress: number
  brokers: BrokerAccount[]
  connectMenuOpen: boolean
  connectingBrokerId: string | null
  onToggleConnectMenu: () => void
  onCloseConnectMenu: () => void
  onConnectBroker: (brokerId: string) => void
  onToggle: (v: boolean) => void
  onDelete: () => void
  onKeywords: () => void
}) {
  const t = useT()
  const ce = t.copierEnginePage
  const username = channel.channel_username?.replace(/^@/, '') || undefined
  const menuRef = useRef<HTMLDivElement>(null)
  const connectedBrokers = useMemo(
    () => brokersMatchingChannel(brokers, channel.id),
    [brokers, channel.id],
  )
  const availableBrokers = useMemo(
    () => brokersNotMatchingChannel(brokers, channel.id),
    [brokers, channel.id],
  )
  const hasAnyBrokers = brokers.some(b => b.is_active)

  useEffect(() => {
    if (!connectMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onCloseConnectMenu()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [connectMenuOpen, onCloseConnectMenu])

  return (
    <div className="hover:bg-neutral-50 dark:hover:bg-neutral-800/80 transition-colors">
      <div className="flex items-center gap-3 px-4 py-3">
        <TgChannelAvatar title={channel.display_name} username={username} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{channel.display_name}</h3>
            {!channel.is_active && <Badge variant="neutral" size="sm">{ce.statusPaused}</Badge>}
          </div>
          {username && <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">@{username}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={channel.is_active} onChange={onToggle} />
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-error-50 hover:text-error-600 transition-colors"
            aria-label={interpolate(ce.removeAria, { label: channel.display_name })}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 px-4 py-2.5 space-y-2.5">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 mb-1.5">{ce.connectedBrokers}</p>
          {connectedBrokers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {connectedBrokers.map(broker => (
                <Badge key={broker.id} variant="neutral" size="sm">
                  {getBrokerDisplayLabel(broker)}
                </Badge>
              ))}
              {(availableBrokers.length > 0 || connectedBrokers.length > 0) && (
                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={onToggleConnectMenu}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-white dark:hover:bg-neutral-900 transition-colors"
                    aria-label={interpolate(ce.addBrokerConnectionAria, { channel: channel.display_name })}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  {connectMenuOpen && (
                    <div className="absolute left-0 top-full z-20 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
                      {!hasAnyBrokers ? (
                        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{ce.noBrokersYet}</p>
                      ) : availableBrokers.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{ce.connectedBrokers}</p>
                      ) : (
                        availableBrokers.map(broker => (
                          <button
                            key={broker.id}
                            type="button"
                            disabled={connectingBrokerId === broker.id}
                            onClick={() => onConnectBroker(broker.id)}
                            className="w-full px-3 py-2 text-left text-sm text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                          >
                            {getBrokerDisplayLabel(broker)}
                          </button>
                        ))
                      )}
                      <div className="border-t border-neutral-100 dark:border-neutral-800 mt-1 pt-1">
                        <Link
                          to="/account-configuration"
                          className="block px-3 py-2 text-xs text-primary-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                          onClick={onCloseConnectMenu}
                        >
                          {ce.connectBrokerInConfig}
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : hasAnyBrokers ? (
            <div className="relative inline-block" ref={menuRef}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onToggleConnectMenu}
                loading={connectingBrokerId !== null}
              >
                {ce.connectToBroker}
              </Button>
              {connectMenuOpen && availableBrokers.length > 0 && (
                <div className="absolute left-0 top-full z-20 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
                  {availableBrokers.map(broker => (
                    <button
                      key={broker.id}
                      type="button"
                      disabled={connectingBrokerId === broker.id}
                      onClick={() => onConnectBroker(broker.id)}
                      className="w-full px-3 py-2 text-left text-sm text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {getBrokerDisplayLabel(broker)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Link
              to="/account-configuration"
              className="inline-flex items-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-xs font-medium text-primary-600 hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              {ce.connectToBroker}
            </Link>
          )}
        </div>
        {isAnalyzing ? (
          <div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5">
              {interpolate(ce.analyzing, {
                percent: String(Math.max(0, Math.min(100, Math.round(analysisProgress)))),
              })}
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-300"
                style={{ width: `${Math.max(0, Math.min(100, analysisProgress))}%` }}
              />
            </div>
          </div>
        ) : !profile ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{ce.profilePending}</p>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="neutral" size="sm">{interpolate(ce.profileType, { value: profile.signal_type })}</Badge>
              <Badge variant="neutral" size="sm">{interpolate(ce.profileEntry, { value: profile.entry_type })}</Badge>
              <Badge variant="neutral" size="sm">{interpolate(ce.profileTp, { value: profile.tp_style })}</Badge>
              <Badge variant="neutral" size="sm">{interpolate(ce.profileSl, { value: profile.sl_style })}</Badge>
            </div>
            {profile.analysis_summary && (
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 line-clamp-2">{profile.analysis_summary}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
