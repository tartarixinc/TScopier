import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useT } from '../../context/LocaleContext'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Radio, Flame, ChevronDown, ChevronUp, Search, X, Copy, Check, ListFilter } from 'lucide-react'
import type { SignalChannel } from '../../types/database'

const ONE_HOUR_MS = 60 * 60 * 1000
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS

type SortKey = 'subscribers' | 'signals' | 'recent' | 'newest'

function formatSubscribers(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toLocaleString()
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-700/60 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function channelStatus(lastLiveAt: string | null, lastSignalAt: string | null): { label: string; live: boolean } {
  const ts = lastLiveAt ?? lastSignalAt
  if (!ts) return { label: 'No activity recorded', live: false }
  const age = Date.now() - new Date(ts).getTime()
  if (age < ONE_HOUR_MS) return { label: 'Live', live: true }
  if (age < TWENTY_FOUR_HOURS_MS) return { label: `Active ${formatRelativeTime(ts)}`, live: false }
  return { label: `Last active ${formatRelativeTime(ts)}`, live: false }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleCopy = useCallback(() => {
    clearTimeout(timerRef.current)
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 rounded text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

export function PopularChannelsPage() {
  const t = useT()
  const p = t.popularChannelsPage
  const [channels, setChannels] = useState<SignalChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('subscribers')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [signalCounts, setSignalCounts] = useState<Map<string, number>>(new Map())
  const [lastSignalAt, setLastSignalAt] = useState<Map<string, string>>(new Map())

  const loadChannels = async () => {
    const { data } = await supabase
      .from('signal_channels')
      .select('*')
      .gt('subscriber_count', 0)
      .order('subscriber_count', { ascending: false })
    const list = data ?? []
    setChannels(list)

    const ids = list.map(c => c.id)
    if (ids.length > 0) {
      const { data: signalRows } = await supabase
        .from('channel_signals')
        .select('signal_channel_id, created_at')
        .in('signal_channel_id', ids)
        .order('created_at', { ascending: false })

      const counts = new Map<string, number>()
      const lastAt = new Map<string, string>()
      for (const row of signalRows ?? []) {
        const id = row.signal_channel_id
        counts.set(id, (counts.get(id) ?? 0) + 1)
        if (!lastAt.has(id)) {
          lastAt.set(id, row.created_at)
        }
      }
      setSignalCounts(counts)
      setLastSignalAt(lastAt)
    }

    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChannels()
  }, [])

  const filteredAndSorted = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    const result = q
      ? channels.filter(
          ch =>
            ch.display_name.toLowerCase().includes(q) ||
            ch.channel_username?.toLowerCase().includes(q),
        )
      : [...channels]

    switch (sort) {
      case 'subscribers':
        result.sort((a, b) => b.subscriber_count - a.subscriber_count)
        break
      case 'signals':
        result.sort((a, b) => (signalCounts.get(b.id) ?? 0) - (signalCounts.get(a.id) ?? 0))
        break
      case 'recent':
        result.sort((a, b) => {
          const aTime = a.last_live_at
            ? new Date(a.last_live_at).getTime()
            : (lastSignalAt.get(a.id) ? new Date(lastSignalAt.get(a.id)!).getTime() : 0)
          const bTime = b.last_live_at
            ? new Date(b.last_live_at).getTime()
            : (lastSignalAt.get(b.id) ? new Date(lastSignalAt.get(b.id)!).getTime() : 0)
          return bTime - aTime
        })
        break
      case 'newest':
        result.sort((a, b) => new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime())
        break
    }
    return result
  }, [channels, searchQuery, sort, signalCounts, lastSignalAt])

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'subscribers', label: 'Most subscribers' },
    { key: 'signals', label: 'Most signals' },
    { key: 'recent', label: 'Recently active' },
    { key: 'newest', label: 'Newest first' },
  ]

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader title={p.title} />

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search channels..."
            className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="relative w-44">
          <ListFilter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 appearance-none focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
          >
            {sortOptions.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-16 bg-white dark:bg-neutral-950 rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 animate-pulse"
            />
          ))}
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <Card>
          <div className="text-center py-10">
            <Flame className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              {searchQuery ? 'No channels match your search' : p.emptyTitle}
            </p>
            <p className="text-xs text-neutral-400 mt-1">
              {searchQuery ? 'Try a different name or username' : p.emptySubtitle}
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="none" className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {filteredAndSorted.map((ch, idx) => {
            const status = channelStatus(ch.last_live_at, lastSignalAt.get(ch.id) ?? null)
            const expanded = expandedId === ch.id
            const signalCount = signalCounts.get(ch.id) ?? 0
            return (
              <div key={ch.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : ch.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                >
                  <span className="w-6 text-xs font-semibold text-neutral-300 dark:text-neutral-600 text-center shrink-0">
                    #{idx + 1}
                  </span>
                  <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center shrink-0">
                    <Radio className="w-4 h-4 text-primary-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">
                      {highlightText(ch.display_name, searchQuery)}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {ch.channel_username && (
                        <p className="text-xs text-neutral-400">@{highlightText(ch.channel_username, searchQuery)}</p>
                      )}
                      <span className="text-neutral-300 dark:text-neutral-600">·</span>
                      <div className="flex items-center gap-1">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            status.live ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'
                          }`}
                        />
                        <span className="text-xs text-neutral-400">{status.label}</span>
                      </div>
                    </div>
                  </div>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 font-medium shrink-0">
                    {formatSubscribers(ch.subscriber_count)} subscribers
                  </span>
                  {expanded ? (
                    <ChevronUp className="w-4 h-4 text-neutral-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-neutral-400 shrink-0" />
                  )}
                </button>

                {expanded && (
                  <div className="px-4 pb-4 pt-3 bg-neutral-50 dark:bg-neutral-800/30 border-t border-neutral-100 dark:border-neutral-800">
                    <div className="flex items-center gap-2 mb-3">
                      <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                        {highlightText(ch.display_name, searchQuery)}
                      </p>
                      <CopyButton text={ch.display_name} />
                    </div>
                    <div className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
                      <div>
                        <span className="text-xs text-neutral-400">Username</span>
                        <div className="flex items-center gap-1">
                          <p className="text-sm text-neutral-700 dark:text-neutral-300 font-mono truncate">
                            @{highlightText(ch.channel_username ?? '', searchQuery)}
                          </p>
                          <CopyButton text={`@${ch.channel_username}`} />
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-neutral-400">Channel ID</span>
                        <div className="flex items-center gap-1">
                          <p className="text-sm text-neutral-700 dark:text-neutral-300 font-mono truncate">
                            {ch.telegram_chat_id}
                          </p>
                          <CopyButton text={ch.telegram_chat_id} />
                        </div>
                      </div>
                      <div>
                        <span className="text-xs text-neutral-400">Subscribers</span>
                        <p className="text-sm text-neutral-700 dark:text-neutral-300">
                          {ch.subscriber_count.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-neutral-400">Signals generated</span>
                        <p className="text-sm text-neutral-700 dark:text-neutral-300">
                          {signalCount.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-neutral-400">First seen</span>
                        <p className="text-sm text-neutral-700 dark:text-neutral-300">
                          {new Date(ch.first_seen_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-neutral-400">Last activity</span>
                        <p className="text-sm text-neutral-700 dark:text-neutral-300">
                          {ch.last_live_at
                            ? new Date(ch.last_live_at).toLocaleString()
                            : lastSignalAt.get(ch.id)
                              ? `${new Date(lastSignalAt.get(ch.id)!).toLocaleString()} (by signal)`
                              : '—'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}
    </PageShell>
  )
}
