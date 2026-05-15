import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import type { Signal } from '../../types/database'
import {
  buildSignalSymbolLookup,
  symbolForCopierLog,
  type SignalSymbolLookupRow,
} from '../../lib/copierLogDisplay'

type Filter = 'all' | 'executed' | 'skipped' | 'failed' | 'pending'

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

function buildChannelDisplayNames(channels: ChannelNameRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

function channelLabel(channelId: string | null | undefined, names: Record<string, string>): string {
  if (!channelId) return '—'
  return names[channelId] ?? 'Unknown channel'
}

export function CopierLogsPage() {
  const { user } = useAuth()
  const [signals, setSignals] = useState<Signal[]>([])
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>({})
  const [symbolLookup, setSymbolLookup] = useState<Map<string, SignalSymbolLookupRow>>(() => new Map())
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    loadSignals()
  }, [user, filter])

  const loadSignals = async () => {
    setLoading(true)
    let query = supabase
      .from('signals')
      .select('*')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false })
      .limit(100)
    if (filter !== 'all') query = query.eq('status', filter)
    const [channelsRes, signalsRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username')
        .eq('user_id', user!.id),
      query,
    ])
    const loaded = (signalsRes.data ?? []) as Signal[]
    setChannelDisplayNames(buildChannelDisplayNames((channelsRes.data ?? []) as ChannelNameRow[]))
    setSymbolLookup(await buildSignalSymbolLookup(supabase, user!.id, loaded))
    setSignals(loaded)
    setLoading(false)
  }

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'executed', label: 'Executed' },
    { value: 'skipped', label: 'Skipped' },
    { value: 'failed', label: 'Failed' },
    { value: 'pending', label: 'Pending' },
  ]

  const statusConfig: Record<string, { variant: 'success' | 'warning' | 'error' | 'neutral' | 'primary'; label: string }> = {
    executed: { variant: 'success', label: 'Executed' },
    skipped:  { variant: 'warning', label: 'Skipped' },
    failed:   { variant: 'error', label: 'Failed' },
    pending:  { variant: 'neutral', label: 'Pending' },
    parsed:   { variant: 'primary', label: 'Parsed' },
  }

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:p-8 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 sm:mb-6 gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-50">Copier Logs</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">Full history of signals received and their execution outcome</p>
        </div>
        {/* Filter tabs */}
        <div className="flex bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5 gap-0.5">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                filter === f.value ? 'bg-teal-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className="overflow-x-auto">
        {/* Header */}
        <div className="grid grid-cols-[1.5fr_1.2fr_1fr_1.2fr_1fr_1fr_auto] gap-3 min-w-[44rem] px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-semibold text-neutral-400 uppercase tracking-wide">
          <span>Status</span>
          <span>Reason</span>
          <span>Channel</span>
          <span>Symbol</span>
          <span>Message</span>
          <span>Type</span>
          <span className="text-right">Time</span>
        </div>

        {loading ? (
          <div className="divide-y divide-neutral-50">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="px-5 py-3.5 grid grid-cols-7 gap-3">
                {[...Array(7)].map((_, j) => (
                  <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                ))}
              </div>
            ))}
          </div>
        ) : signals.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-16 h-16 bg-neutral-100 dark:bg-neutral-800 rounded-2xl mx-auto mb-3 flex items-center justify-center">
              <svg className="w-8 h-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-neutral-400">No logs yet</p>
            <p className="text-xs text-neutral-300 mt-1">Signal logs will appear here once your copier receives messages</p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-50">
            {signals.map(signal => {
              const parsed = signal.parsed_data as Record<string, unknown> | null
              const action = parsed?.action as string | undefined
              const symbol = symbolForCopierLog(signal, symbolLookup)
              const s = statusConfig[signal.status] ?? { variant: 'neutral' as const, label: signal.status }
              const channelName = channelLabel(signal.channel_id, channelDisplayNames)

              return (
                <div key={signal.id} className="grid grid-cols-[1.5fr_1.2fr_1fr_1.2fr_1fr_1fr_auto] gap-3 min-w-[44rem] px-4 sm:px-5 py-3.5 items-center hover:bg-neutral-50 dark:bg-neutral-800/50 transition-colors">
                  <Badge variant={s.variant} size="sm">{s.label}</Badge>
                  <span
                    className="text-xs text-neutral-500 dark:text-neutral-400 truncate"
                    title={signal.skip_reason ?? ''}
                  >
                    {signal.skip_reason
                      ? (signal.skip_reason.length > 42 ? signal.skip_reason.slice(0, 42) + '…' : signal.skip_reason)
                      : '—'}
                  </span>
                  <span className="text-xs text-neutral-600 dark:text-neutral-400 truncate" title={channelName}>
                    {channelName}
                  </span>
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{symbol}</span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate" title={signal.raw_message}>
                    {signal.raw_message?.slice(0, 60) || '(image)'}
                    {(signal.raw_message?.length ?? 0) > 60 ? '…' : ''}
                  </span>
                  <span className={`text-xs font-medium uppercase ${
                    action === 'buy' ? 'text-primary-600' :
                    action === 'sell' ? 'text-error-600' :
                    'text-neutral-400'
                  }`}>
                    {action ?? '—'}
                  </span>
                  <span className="text-xs text-neutral-400 text-right whitespace-nowrap">
                    {new Date(signal.created_at).toLocaleString([], {
                      month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        </div>
      </Card>
    </div>
  )
}
