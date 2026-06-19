import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { EditSignalOverrideModal } from '../../components/dashboard/EditSignalOverrideModal'
import type { Json, Signal, TelegramChannel } from '../../types/database'
import {
  buildSignalSymbolLookup,
  formatTradeSignalSummary,
  isTelegramTradeSignal,
  parsedSignalAction,
  symbolForCopierLog,
  tradeSignalActionLabel,
  type TradeSignalSummaryLabels,
} from '../../lib/copierLogDisplay'
import {
  buildOpenSignalIdSet,
  effectiveParsedData,
  isEditableEntrySignal,
  resolveSignalOpenStatus,
} from '../../lib/signalOverride'

type DatePreset = 'all' | 'today' | '7d' | '30d' | 'custom'

const selectClass =
  'px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500 w-full'

const dateInputClass =
  'px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500 w-full'

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayInput(): string {
  return formatDateInput(new Date())
}

function daysAgoInput(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return formatDateInput(date)
}

function startOfDay(dateStr: string): Date {
  const date = new Date(dateStr)
  date.setHours(0, 0, 0, 0)
  return date
}

function endOfDay(dateStr: string): Date {
  const date = new Date(dateStr)
  date.setHours(23, 59, 59, 999)
  return date
}

function detectPreset(dateFrom: string, dateTo: string): DatePreset {
  if (!dateFrom && !dateTo) return 'all'
  const today = todayInput()
  if (dateFrom === today && dateTo === today) return 'today'
  if (dateFrom === daysAgoInput(7) && dateTo === today) return '7d'
  if (dateFrom === daysAgoInput(30) && dateTo === today) return '30d'
  return 'custom'
}

function applyPreset(preset: Exclude<DatePreset, 'custom'>): { dateFrom: string; dateTo: string } {
  const today = todayInput()
  switch (preset) {
    case 'all':
      return { dateFrom: '', dateTo: '' }
    case 'today':
      return { dateFrom: today, dateTo: today }
    case '7d':
      return { dateFrom: daysAgoInput(7), dateTo: today }
    case '30d':
      return { dateFrom: daysAgoInput(30), dateTo: today }
  }
}

function signalInDateRange(createdAt: Date, dateFrom: string, dateTo: string): boolean {
  if (dateFrom && createdAt < startOfDay(dateFrom)) return false
  if (dateTo && createdAt > endOfDay(dateTo)) return false
  return true
}

function channelDisplayName(channel: TelegramChannel | undefined): string {
  if (!channel) return 'Unknown channel'
  const name = channel.display_name?.trim()
  const username = channel.channel_username?.trim().replace(/^@/, '')
  return name || (username ? `@${username}` : 'Unnamed channel')
}

function signalForDisplay(signal: Signal): Signal {
  return {
    ...signal,
    parsed_data: effectiveParsedData(signal) as Json,
  }
}

export function SignalHistoryPage() {
  const t = useT()
  const sh = t.signalHistoryPage
  const { user } = useAuth()
  const [signals, setSignals] = useState<Signal[]>([])
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [openSignalIds, setOpenSignalIds] = useState<Set<string>>(() => new Set())
  const [symbolContext, setSymbolContext] = useState(() => ({
    lookup: new Map(),
    replyParentBySignalId: new Map(),
  }))
  const [loading, setLoading] = useState(true)
  const [channelFilter, setChannelFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [editSignal, setEditSignal] = useState<Signal | null>(null)
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const summaryLabels = useMemo((): TradeSignalSummaryLabels => ({
    actionBuy: sh.actionBuy,
    actionSell: sh.actionSell,
    actionClose: sh.actionClose,
    actionCloseWorseEntries: sh.actionCloseWorseEntries,
    actionBreakeven: sh.actionBreakeven,
    actionModify: sh.actionModify,
    actionPartialProfit: sh.actionPartialProfit,
    actionPartialBreakeven: sh.actionPartialBreakeven,
    onSymbol: sh.onSymbol,
    entryAt: sh.entryAt,
    slAt: sh.slAt,
    tpAt: sh.tpAt,
  }), [sh])

  const datePreset = useMemo(() => detectPreset(dateFrom, dateTo), [dateFrom, dateTo])

  const loadData = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const [channelsRes, signalsRes, openTradesRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('signals')
        .select('*')
        .eq('user_id', user.id)
        .or('skip_reason.is.null,skip_reason.neq.non_trade_message')
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase
        .from('trades')
        .select('signal_id')
        .eq('user_id', user.id)
        .eq('status', 'open'),
    ])
    const loadedChannels = (channelsRes.data ?? []) as TelegramChannel[]
    const loadedSignals = ((signalsRes.data ?? []) as Signal[]).filter(isTelegramTradeSignal)
    setChannels(loadedChannels)
    setSignals(loadedSignals)
    setOpenSignalIds(buildOpenSignalIdSet((openTradesRes.data ?? []) as { signal_id?: string | null }[]))
    setSymbolContext(await buildSignalSymbolLookup(supabase, user.id, loadedSignals))
    setLoading(false)
  }, [user])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const channelById = useMemo(() => {
    const map = new Map<string, TelegramChannel>()
    channels.forEach(c => map.set(c.id, c))
    return map
  }, [channels])

  const tradeSignals = useMemo(() => {
    return signals.filter(signal => {
      if (!signal.channel_id) return false
      const ch = channelById.get(signal.channel_id)
      if (!ch) return false
      if (!isTelegramTradeSignal(signal)) return false
      return new Date(signal.created_at).getTime() >= new Date(ch.created_at).getTime()
    })
  }, [signals, channelById])

  const filteredSignals = useMemo(() => {
    return tradeSignals.filter(signal => {
      if (channelFilter !== 'all' && signal.channel_id !== channelFilter) return false
      return signalInDateRange(new Date(signal.created_at), dateFrom, dateTo)
    })
  }, [tradeSignals, channelFilter, dateFrom, dateTo])

  const stats = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const start7d = new Date(now)
    start7d.setDate(now.getDate() - 7)
    const start30d = new Date(now)
    start30d.setDate(now.getDate() - 30)

    return {
      today: tradeSignals.filter(s => new Date(s.created_at) >= startOfToday).length,
      last7d: tradeSignals.filter(s => new Date(s.created_at) >= start7d).length,
      last30d: tradeSignals.filter(s => new Date(s.created_at) >= start30d).length,
      total: tradeSignals.length,
    }
  }, [tradeSignals])

  const resetFilters = () => {
    setChannelFilter('all')
    setDateFrom('')
    setDateTo('')
  }

  const handlePresetChange = (preset: Exclude<DatePreset, 'custom'>) => {
    const next = applyPreset(preset)
    setDateFrom(next.dateFrom)
    setDateTo(next.dateTo)
  }

  const handleSaved = async ({ appliedLegs }: { appliedLegs: number; open: boolean }) => {
    setBanner({
      tone: 'success',
      text: interpolate(sh.applySuccess, { count: String(appliedLegs) }),
    })
    await loadData()
  }

  const presetLabels: Record<DatePreset, string> = {
    all: sh.presetAll,
    today: sh.presetToday,
    '7d': sh.preset7d,
    '30d': sh.preset30d,
    custom: sh.presetCustom,
  }

  return (
    <PageShell maxWidth="lg">
      <PageHeader title={t.pages.signalHistory.title} subtitle={t.pages.signalHistory.description} />

      {banner ? (
        <div
          className={clsx(
            'mb-4 rounded-xl border px-4 py-3 text-sm',
            banner.tone === 'success'
              ? 'border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-100'
              : 'border-error-200 bg-error-50 text-error-800 dark:border-error-900/50 dark:bg-error-950/40 dark:text-error-100',
          )}
        >
          {banner.text}
        </div>
      ) : null}

      <Card className="mb-6" padding="none">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-0 divide-x divide-neutral-100 dark:divide-neutral-800">
          <StatCell label={sh.signalsToday} value={stats.today} />
          <StatCell label={sh.signalsLast7d} value={stats.last7d} />
          <StatCell label={sh.signalsLast30d} value={stats.last30d} />
          <StatCell label={sh.signalsTotal} value={stats.total} />
        </div>
      </Card>

      <Card padding="none">
        <div className="p-4 border-b border-neutral-100 dark:border-neutral-800">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 sr-only">{sh.colChannel}</span>
              <select
                value={channelFilter}
                onChange={e => setChannelFilter(e.target.value)}
                className={selectClass}
              >
                <option value="all">{sh.allChannels}</option>
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>{channelDisplayName(ch)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{sh.dateFrom}</span>
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={e => setDateFrom(e.target.value)}
                className={dateInputClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{sh.dateTo}</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={e => setDateTo(e.target.value)}
                className={dateInputClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 sr-only">Preset</span>
              <select
                value={datePreset}
                onChange={e => {
                  const preset = e.target.value
                  if (preset !== 'custom') handlePresetChange(preset as Exclude<DatePreset, 'custom'>)
                }}
                className={selectClass}
              >
                {datePreset === 'custom' ? (
                  <option value="custom">{sh.presetCustom}</option>
                ) : null}
                {(['all', 'today', '7d', '30d'] as const).map(key => (
                  <option key={key} value={key}>
                    {presetLabels[key]}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={resetFilters} className="px-8 whitespace-nowrap">
              {sh.resetFilters}
            </Button>
          </div>
        </div>

        <div className="px-4 py-2.5 bg-teal-50 dark:bg-teal-950/30 border-b border-teal-100 dark:border-teal-900/40 text-center text-teal-800 dark:text-teal-200 text-sm font-medium">
          {interpolate(sh.totalFound, { count: String(filteredSignals.length) })}
        </div>

        <div className="hidden md:grid md:grid-cols-[1fr_2fr_auto_auto] gap-3 px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
          <span>{sh.colChannel}</span>
          <span>{sh.colSignal}</span>
          <span>{sh.colStatus}</span>
          <span className="text-right">{sh.colTime}</span>
        </div>

        {loading ? (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="px-4 py-4 space-y-2">
                <div className="h-4 w-24 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : filteredSignals.length === 0 ? (
          <div className="py-16 text-center text-neutral-400 text-sm">{sh.noSignals}</div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-[560px] overflow-y-auto">
            {filteredSignals.map(signal => {
              const displaySignal = signalForDisplay(signal)
              const openStatus = resolveSignalOpenStatus(signal, openSignalIds, {
                batchSignals: tradeSignals,
                replyParentBySignalId: symbolContext.replyParentBySignalId,
              })
              const canEdit = openStatus === 'open' && isEditableEntrySignal(signal)
              return (
                <SignalRow
                  key={signal.id}
                  signal={signal}
                  channelName={channelDisplayName(signal.channel_id ? channelById.get(signal.channel_id) : undefined)}
                  summary={formatTradeSignalSummary(displaySignal, symbolContext, tradeSignals, summaryLabels)}
                  actionLabel={tradeSignalActionLabel(parsedSignalAction(signal.parsed_data), summaryLabels)}
                  action={parsedSignalAction(signal.parsed_data)}
                  symbol={symbolForCopierLog(signal, symbolContext, tradeSignals)}
                  openStatus={openStatus}
                  statusOpenLabel={sh.statusOpen}
                  statusClosedLabel={sh.statusClosed}
                  editLabel={sh.editSignal}
                  canEdit={canEdit}
                  onEdit={() => setEditSignal(signal)}
                />
              )
            })}
          </div>
        )}
      </Card>

      <EditSignalOverrideModal
        signal={editSignal}
        onClose={() => setEditSignal(null)}
        onSaved={handleSaved}
      />
    </PageShell>
  )
}

function SignalRow({
  signal,
  channelName,
  summary,
  actionLabel,
  action,
  symbol,
  openStatus,
  statusOpenLabel,
  statusClosedLabel,
  editLabel,
  canEdit,
  onEdit,
}: {
  signal: Signal
  channelName: string
  summary: string
  actionLabel: string
  action: string
  symbol: string
  openStatus: 'open' | 'closed'
  statusOpenLabel: string
  statusClosedLabel: string
  editLabel: string
  canEdit: boolean
  onEdit: () => void
}) {
  const timeLabel = new Date(signal.created_at).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

  const actionTone =
    action === 'buy'
      ? 'text-primary-600 dark:text-primary-400'
      : action === 'sell'
        ? 'text-error-600 dark:text-error-400'
        : 'text-neutral-600 dark:text-neutral-300'

  const statusBadge = (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        openStatus === 'open'
          ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
      )}
    >
      {openStatus === 'open' ? statusOpenLabel : statusClosedLabel}
    </span>
  )

  return (
    <>
      <article className="md:hidden px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{symbol !== '—' ? symbol : actionLabel}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">{channelName}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {statusBadge}
            <span className="text-xs text-neutral-400 whitespace-nowrap">{timeLabel}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className={clsx('text-xs font-semibold uppercase', actionTone)}>{actionLabel}</p>
          {canEdit ? (
            <Button variant="secondary" className="h-7 px-2.5 text-xs" onClick={onEdit}>
              {editLabel}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-neutral-700 dark:text-neutral-200 leading-relaxed">{summary}</p>
      </article>

      <div className="hidden md:grid md:grid-cols-[1fr_2fr_auto_auto] gap-3 px-4 py-3.5 items-center hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channelName}</p>
          {symbol !== '—' ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{symbol}</p>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className={clsx('text-xs font-semibold uppercase mb-1', actionTone)}>{actionLabel}</p>
          <p className="text-sm text-neutral-800 dark:text-neutral-100 truncate" title={summary}>{summary}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {statusBadge}
          {canEdit ? (
            <Button variant="secondary" className="h-7 px-2.5 text-xs" onClick={onEdit}>
              {editLabel}
            </Button>
          ) : null}
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400 text-right whitespace-nowrap">{timeLabel}</span>
      </div>
    </>
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
