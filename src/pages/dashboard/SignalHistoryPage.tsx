import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import type { Signal, TelegramChannel } from '../../types/database'

type TimeFilter = 'all' | 'today' | '7d' | '30d'

export function SignalHistoryPage() {
  const { user } = useAuth()
  const [signals, setSignals] = useState<Signal[]>([])
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [channelFilter, setChannelFilter] = useState('all')
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    setLoading(true)
    const [channelsRes, signalsRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('signals')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(1000),
    ])
    setChannels((channelsRes.data ?? []) as TelegramChannel[])
    setSignals((signalsRes.data ?? []) as Signal[])
    setLoading(false)
  }

  const channelById = useMemo(() => {
    const map = new Map<string, TelegramChannel>()
    channels.forEach(c => map.set(c.id, c))
    return map
  }, [channels])

  const baseSignals = useMemo(() => {
    return signals.filter(signal => {
      if (!signal.channel_id) return false
      const ch = channelById.get(signal.channel_id)
      if (!ch) return false
      // Only include history from when the channel was connected.
      return new Date(signal.created_at).getTime() >= new Date(ch.created_at).getTime()
    })
  }, [signals, channelById])

  const filteredSignals = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const start7d = new Date(now)
    start7d.setDate(now.getDate() - 7)
    const start30d = new Date(now)
    start30d.setDate(now.getDate() - 30)

    return baseSignals.filter(signal => {
      if (channelFilter !== 'all' && signal.channel_id !== channelFilter) return false
      const createdAt = new Date(signal.created_at)
      if (timeFilter === 'today') return createdAt >= startOfToday
      if (timeFilter === '7d') return createdAt >= start7d
      if (timeFilter === '30d') return createdAt >= start30d
      return true
    })
  }, [baseSignals, channelFilter, timeFilter])

  const stats = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const start7d = new Date(now)
    start7d.setDate(now.getDate() - 7)
    const start30d = new Date(now)
    start30d.setDate(now.getDate() - 30)

    const total = baseSignals.length
    const today = baseSignals.filter(s => new Date(s.created_at) >= startOfToday).length
    const thisWeek = baseSignals.filter(s => new Date(s.created_at) >= startOfWeek).length
    const thisMonth = baseSignals.filter(s => new Date(s.created_at) >= startOfMonth).length
    const last7d = baseSignals.filter(s => new Date(s.created_at) >= start7d).length
    const last30d = baseSignals.filter(s => new Date(s.created_at) >= start30d).length
    const totalChannels = new Set(baseSignals.map(s => s.channel_id).filter(Boolean)).size

    return { total, today, thisWeek, thisMonth, last7d, last30d, totalChannels }
  }, [baseSignals])

  const resetFilters = () => {
    setChannelFilter('all')
    setTimeFilter('all')
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">Signal History</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          View parsed signals connected to your account. Filter by channel and date range.
        </p>
      </div>

      <Card className="mb-6" padding="none">
        <div className="grid grid-cols-4 gap-0 divide-x divide-neutral-100 dark:divide-neutral-800">
          <StatCell label="Signals received (Today)" value={stats.today} />
          <StatCell label="Signals received (Last 7 days)" value={stats.last7d} />
          <StatCell label="Signals received (Last 30 days)" value={stats.last30d} />
          <StatCell label="Signals received (Total)" value={stats.total} />
        </div>
        <div className="grid grid-cols-4 gap-0 divide-x divide-neutral-100 dark:divide-neutral-800 border-t border-neutral-100 dark:border-neutral-800">
          <StatCell label="Signals received (This week)" value={stats.thisWeek} />
          <StatCell label="Signals received (This month)" value={stats.thisMonth} />
          <StatCell label="Total channels" value={stats.totalChannels} />
          <div className="px-6 py-4 flex items-center justify-start">
            <span className="text-primary-600 text-sm font-medium">Channel Details</span>
          </div>
        </div>
      </Card>

      <Card padding="none">
        <div className="p-4 border-b border-neutral-100 dark:border-neutral-800">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-3">
            <select
              value={channelFilter}
              onChange={e => setChannelFilter(e.target.value)}
              className="px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Channels</option>
              {channels.map(ch => (
                <option key={ch.id} value={ch.id}>{ch.display_name}</option>
              ))}
            </select>
            <select
              value={timeFilter}
              onChange={e => setTimeFilter(e.target.value as TimeFilter)}
              className="px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Time</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <Button onClick={resetFilters} className="px-8">
              Reset Filters
            </Button>
          </div>
        </div>

        <div className="px-4 py-2.5 bg-success-50 border-b border-success-100 text-center text-success-800 font-medium">
          Total found: {filteredSignals.length}
        </div>

        <div className="grid grid-cols-[60px_1.2fr_1fr_2.6fr_1fr_1fr] gap-3 px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
          <span>#</span>
          <span>Channel Name</span>
          <span>Channel ID</span>
          <span>Signal</span>
          <span>Signal Ref.</span>
          <span>Time</span>
        </div>

        {loading ? (
          <div className="divide-y divide-neutral-50">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="grid grid-cols-[60px_1.2fr_1fr_2.6fr_1fr_1fr] gap-3 px-4 py-3">
                {[...Array(6)].map((__, j) => (
                  <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                ))}
              </div>
            ))}
          </div>
        ) : filteredSignals.length === 0 ? (
          <div className="py-16 text-center text-neutral-400 text-sm">No signals found for selected filters.</div>
        ) : (
          <div className="divide-y divide-neutral-50 max-h-[560px] overflow-y-auto">
            {filteredSignals.map((signal, index) => {
              const parsed = signal.parsed_data as Record<string, unknown> | null
              const channel = signal.channel_id ? channelById.get(signal.channel_id) : null
              const signalRef = parsed?.telegram_message_id != null
                ? String(parsed.telegram_message_id)
                : signal.telegram_message_id ?? signal.id.slice(0, 8)
              return (
                <div key={signal.id} className="grid grid-cols-[60px_1.2fr_1fr_2.6fr_1fr_1fr] gap-3 px-4 py-3 text-sm hover:bg-neutral-50 dark:bg-neutral-800/50 transition-colors">
                  <span className="text-neutral-600 dark:text-neutral-400">{index + 1}</span>
                  <span className="font-medium text-neutral-900 dark:text-neutral-50 truncate">{channel?.display_name ?? 'Unknown'}</span>
                  <span className="text-neutral-700 dark:text-neutral-300 truncate">{channel?.channel_id ?? '—'}</span>
                  <span className="text-neutral-800 dark:text-neutral-100 truncate" title={signal.raw_message}>
                    {signal.raw_message || '(image signal)'}
                  </span>
                  <span className="text-neutral-700 dark:text-neutral-300">{signalRef}</span>
                  <span className="text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                    {new Date(signal.created_at).toLocaleString([], {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-6 py-4">
      <p className="text-xs text-neutral-400 mb-1.5">{label}</p>
      <p className="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
    </div>
  )
}

