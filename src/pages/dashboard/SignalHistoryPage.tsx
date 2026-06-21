import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Pencil } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import {
  buildEditSignalOverrideSnapshot,
  EditSignalOverrideModal,
  type EditSignalOverrideSnapshot,
} from '../../components/dashboard/EditSignalOverrideModal'
import type { Json, Signal, TelegramChannel } from '../../types/database'
import {
  buildSignalSymbolLookup,
  formatTradeSignalSummary,
  isTelegramTradeSignal,
  parsedSignalAction,
  symbolForCopierLog,
  tradeSignalActionLabel,
  type CopierSymbolContext,
  type TradeSignalSummaryLabels,
} from '../../lib/copierLogDisplay'
import {
  buildConsolidatedEntrySignals,
  buildOpenSignalIdSet,
  effectiveDisplayParsedData,
  enrichSignalDisplayContext,
  isEditableEntrySignal,
  resolveSignalOpenStatus,
  type SignalBatchRow,
  type SignalDisplayContext,
} from '../../lib/signalOverride'
import { useSignalHistoryRealtime } from '../../hooks/useSignalHistoryRealtime'

const SIGNALS_PAGE_LIMIT = 500

type DatePreset = 'all' | 'today' | '7d' | '30d' | 'custom'

const DESKTOP_TD = 'px-4 py-3.5 align-middle border-b border-neutral-100 dark:border-neutral-800'

const DESKTOP_TH =
  'px-4 py-3 text-left text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900'

const OPEN_ROW_BG = 'bg-teal-50 dark:bg-teal-950/40'
const OPEN_ROW_HOVER = 'group-hover:bg-teal-100 dark:group-hover:bg-teal-900/50'
const OPEN_ROW_CELL = 'transition-colors duration-150'
const EDIT_PEN_ICON = 'w-4 h-4 shrink-0 text-teal-600 dark:text-teal-400 opacity-0 group-hover:opacity-100 transition-opacity duration-150'

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

function matchesDateFilter(
  entryCreatedAt: string,
  lastActivityAt: string,
  dateFrom: string,
  dateTo: string,
): boolean {
  if (!dateFrom && !dateTo) return true
  return signalInDateRange(new Date(entryCreatedAt), dateFrom, dateTo)
    || signalInDateRange(new Date(lastActivityAt), dateFrom, dateTo)
}

function channelDisplayName(channel: TelegramChannel | undefined): string {
  if (!channel) return 'Unknown channel'
  const name = channel.display_name?.trim()
  const username = channel.channel_username?.trim().replace(/^@/, '')
  return name || (username ? `@${username}` : 'Unnamed channel')
}

function signalForDisplay(
  signal: Signal,
  ctx: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): Signal {
  return {
    ...signal,
    parsed_data: effectiveDisplayParsedData(signal, ctx, absorbedEntryUpdates) as Json,
  }
}

type SignalRowContentProps = {
  channelName: string
  summary: string
  actionLabel: string
  action: string
  symbol: string
  openStatus: 'open' | 'closed'
  statusOpenLabel: string
  statusClosedLabel: string
  timeLabel: string
  onClick?: () => void
}

export function SignalHistoryPage() {
  const t = useT()
  const sh = t.signalHistoryPage
  const { user } = useAuth()
  const [signals, setSignals] = useState<Signal[]>([])
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [openSignalIds, setOpenSignalIds] = useState<Set<string>>(() => new Set())
  const [symbolContext, setSymbolContext] = useState<CopierSymbolContext>(() => ({
    lookup: new Map(),
    replyParentBySignalId: new Map(),
  }))
  const [loading, setLoading] = useState(true)
  const [symbolLookupReady, setSymbolLookupReady] = useState(false)
  const [channelFilter, setChannelFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [editSession, setEditSession] = useState<EditSignalOverrideSnapshot | null>(null)
  const editModalOpenRef = useRef(false)
  editModalOpenRef.current = editSession != null
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

  const loadData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!user) return
    const silent = opts?.silent ?? false
    if (!silent) {
      setLoading(true)
      setSymbolLookupReady(false)
    }
    const [channelsRes, signalsRes, openTradesRes] = await Promise.all([
      supabase
        .from('telegram_channels')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('signals')
        .select('id,channel_id,created_at,parsed_data,raw_message,parent_signal_id,user_override,reply_to_message_id,is_modification,skip_reason,telegram_message_id')
        .eq('user_id', user.id)
        .or('skip_reason.is.null,skip_reason.neq.non_trade_message')
        .order('created_at', { ascending: false })
        .limit(SIGNALS_PAGE_LIMIT),
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
    if (!silent) setLoading(false)

    const nextSymbolContext = await buildSignalSymbolLookup(supabase, user.id, loadedSignals)
    setSymbolContext(nextSymbolContext)
    setSymbolLookupReady(true)
  }, [user])

  const refreshAfterOverrideSave = useCallback(async (signalId: string) => {
    if (!user) return
    const [openTradesRes, signalRes] = await Promise.all([
      supabase
        .from('trades')
        .select('signal_id')
        .eq('user_id', user.id)
        .eq('status', 'open'),
      supabase
        .from('signals')
        .select('id,channel_id,created_at,parsed_data,raw_message,parent_signal_id,user_override,reply_to_message_id,is_modification,skip_reason,telegram_message_id')
        .eq('id', signalId)
        .maybeSingle(),
    ])
    setOpenSignalIds(buildOpenSignalIdSet((openTradesRes.data ?? []) as { signal_id?: string | null }[]))
    const updated = signalRes.data as Signal | null
    if (updated) {
      setSignals(prev => prev.map(row => (row.id === updated.id ? updated : row)))
    }
  }, [user])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const refreshData = useCallback(() => {
    if (editModalOpenRef.current) return
    void loadData({ silent: true })
  }, [loadData])

  useSignalHistoryRealtime(user?.id, refreshData)

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

  const entrySignals = useMemo(
    () => tradeSignals.filter(isEditableEntrySignal),
    [tradeSignals],
  )

  const displayContext = useMemo((): SignalDisplayContext => enrichSignalDisplayContext({
    batchSignals: tradeSignals,
    symbolContext,
    replyParentBySignalId: symbolContext.replyParentBySignalId,
  }), [tradeSignals, symbolContext])

  const openStatusContext = useMemo(() => ({
    batchSignals: tradeSignals,
    replyParentBySignalId: symbolContext.replyParentBySignalId,
    parentSignalIdByRowId: displayContext.batchIndex?.parentSignalIdByRowId,
  }), [tradeSignals, symbolContext.replyParentBySignalId, displayContext.batchIndex])

  const allConsolidatedSignals = useMemo(
    () => buildConsolidatedEntrySignals(tradeSignals, displayContext, openSignalIds),
    [tradeSignals, displayContext, openSignalIds],
  )

  const consolidatedSignals = useMemo(() => {
    return allConsolidatedSignals
      .filter(({ signal, lastActivityAt }) => {
        if (channelFilter !== 'all' && signal.channel_id !== channelFilter) return false
        return matchesDateFilter(signal.created_at, lastActivityAt, dateFrom, dateTo)
      })
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
  }, [allConsolidatedSignals, channelFilter, dateFrom, dateTo])

  const handleSelectSignal = useCallback((
    signal: Signal,
    absorbedEntryUpdates: ReadonlyArray<SignalBatchRow>,
    ctx: SignalDisplayContext,
  ) => {
    setEditSession(buildEditSignalOverrideSnapshot(signal, ctx, absorbedEntryUpdates))
  }, [])

  const closeEditModal = useCallback(() => {
    setEditSession(null)
  }, [])

  const handleSaved = useCallback(async (
    signalId: string,
    { appliedLegs }: { appliedLegs: number; open: boolean },
  ) => {
    setBanner({
      tone: 'success',
      text: interpolate(sh.applySuccess, { count: String(appliedLegs) }),
    })
    await refreshAfterOverrideSave(signalId)
  }, [refreshAfterOverrideSave, sh.applySuccess])

  const signalDisplayRows = useMemo(() => {
    if (!symbolLookupReady) return []
    return consolidatedSignals.map(({ signal, lastActivityAt, absorbedEntryUpdates }) => {
      const displaySignal = signalForDisplay(signal, displayContext, absorbedEntryUpdates)
      const openStatus = resolveSignalOpenStatus(signal, openSignalIds, openStatusContext)
      return {
        key: signal.id,
        channelName: channelDisplayName(signal.channel_id ? channelById.get(signal.channel_id) : undefined),
        summary: formatTradeSignalSummary(displaySignal, symbolContext, tradeSignals, summaryLabels),
        actionLabel: tradeSignalActionLabel(parsedSignalAction(signal.parsed_data), summaryLabels),
        action: parsedSignalAction(signal.parsed_data),
        symbol: symbolForCopierLog(signal, symbolContext, tradeSignals),
        openStatus,
        timeLabel: lastActivityAt,
        onClick: openStatus === 'open'
          ? () => handleSelectSignal(signal, absorbedEntryUpdates, displayContext)
          : undefined,
      }
    })
  }, [
    symbolLookupReady,
    consolidatedSignals,
    displayContext,
    symbolContext,
    tradeSignals,
    summaryLabels,
    openSignalIds,
    openStatusContext,
    channelById,
    handleSelectSignal,
  ])

  const stats = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const start7d = new Date(now)
    start7d.setDate(now.getDate() - 7)
    const start30d = new Date(now)
    start30d.setDate(now.getDate() - 30)

    return {
      today: entrySignals.filter(s => new Date(s.created_at) >= startOfToday).length,
      last7d: entrySignals.filter(s => new Date(s.created_at) >= start7d).length,
      last30d: entrySignals.filter(s => new Date(s.created_at) >= start30d).length,
      total: entrySignals.length,
    }
  }, [entrySignals])

  const handleSavedFromModal = useCallback(async (result: { appliedLegs: number; open: boolean }) => {
    if (!editSession) return
    await handleSaved(editSession.signalId, result)
  }, [editSession, handleSaved])

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

  const listLoading = loading || !symbolLookupReady
  const showEmpty = !listLoading && signalDisplayRows.length === 0

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

        <div className="hidden md:block max-h-[560px] overflow-y-auto">
          <table className="md:table w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[46%]" />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-white dark:bg-neutral-900">
              <tr>
                <th className={DESKTOP_TH}>{sh.colChannel}</th>
                <th className={DESKTOP_TH}>{sh.colSignal}</th>
                <th className={clsx(DESKTOP_TH, 'text-center')}>{sh.colStatus}</th>
                <th className={clsx(DESKTOP_TH, 'text-right')}>{sh.colTime}</th>
              </tr>
            </thead>
            <tbody>
              {listLoading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={4} className="px-4 py-4">
                      <div className="space-y-2">
                        <div className="h-4 w-24 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                        <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                      </div>
                    </td>
                  </tr>
                ))
              ) : showEmpty ? (
                <tr>
                  <td colSpan={4} className="py-16 text-center text-neutral-400 text-sm">{sh.noSignals}</td>
                </tr>
              ) : (
                signalDisplayRows.map(row => (
                  <SignalRow
                    key={row.key}
                    channelName={row.channelName}
                    summary={row.summary}
                    actionLabel={row.actionLabel}
                    action={row.action}
                    symbol={row.symbol}
                    openStatus={row.openStatus}
                    statusOpenLabel={sh.statusOpen}
                    statusClosedLabel={sh.statusClosed}
                    timeLabel={row.timeLabel}
                    onClick={row.onClick}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="md:hidden max-h-[560px] overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
          {listLoading ? (
            [...Array(6)].map((_, i) => (
              <div key={i} className="px-4 py-4 space-y-2">
                <div className="h-4 w-24 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
              </div>
            ))
          ) : showEmpty ? (
            <div className="py-16 text-center text-neutral-400 text-sm">{sh.noSignals}</div>
          ) : (
            signalDisplayRows.map(row => (
              <SignalRow
                key={`m-${row.key}`}
                mobileOnly
                channelName={row.channelName}
                summary={row.summary}
                actionLabel={row.actionLabel}
                action={row.action}
                symbol={row.symbol}
                openStatus={row.openStatus}
                statusOpenLabel={sh.statusOpen}
                statusClosedLabel={sh.statusClosed}
                timeLabel={row.timeLabel}
                onClick={row.onClick}
              />
            ))
          )}
        </div>
      </Card>

      {editSession ? (
        <EditSignalOverrideModal
          key={editSession.signalId}
          {...editSession}
          onClose={closeEditModal}
          onSaved={handleSavedFromModal}
        />
      ) : null}
    </PageShell>
  )
}

const SignalRow = memo(function SignalRow({
  mobileOnly,
  channelName,
  summary,
  actionLabel,
  action,
  symbol,
  openStatus,
  statusOpenLabel,
  statusClosedLabel,
  timeLabel,
  onClick,
}: SignalRowContentProps & { mobileOnly?: boolean }) {
  const formattedTime = new Date(timeLabel).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

  const isOpen = openStatus === 'open'

  const actionTone =
    action === 'buy'
      ? 'text-primary-600 dark:text-primary-400'
      : action === 'sell'
        ? 'text-error-600 dark:text-error-400'
        : 'text-neutral-600 dark:text-neutral-300'

  const openRowCellClass = isOpen
    ? clsx(OPEN_ROW_BG, OPEN_ROW_HOVER, OPEN_ROW_CELL)
    : undefined

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!onClick) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  const rowProps = isOpen && onClick
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick,
        onKeyDown: handleKeyDown,
      }
    : {}

  const statusBadge = (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        isOpen
          ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
      )}
    >
      {isOpen ? statusOpenLabel : statusClosedLabel}
    </span>
  )

  const signalContent = (
    <>
      <p className={clsx('text-xs font-semibold uppercase mb-1', actionTone)}>{actionLabel}</p>
      <p className="text-sm text-neutral-800 dark:text-neutral-100 truncate" title={summary}>{summary}</p>
    </>
  )

  const signalContentMobile = (
    <>
      <p className={clsx('text-xs font-semibold uppercase mb-1.5', actionTone)}>{actionLabel}</p>
      <p className="text-sm text-neutral-700 dark:text-neutral-200 leading-relaxed">{summary}</p>
    </>
  )

  if (mobileOnly) {
    return (
      <article
        {...rowProps}
        className={clsx('px-4 py-4', isOpen && 'group cursor-pointer', openRowCellClass)}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{symbol !== '—' ? symbol : actionLabel}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">{channelName}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {statusBadge}
            <span className="text-xs text-neutral-400 whitespace-nowrap">{formattedTime}</span>
          </div>
        </div>
        {isOpen ? (
          <div className="flex items-start gap-2 min-w-0">
            <div className="min-w-0 flex-1">{signalContentMobile}</div>
            <Pencil className={clsx(EDIT_PEN_ICON, 'mt-0.5')} aria-hidden />
          </div>
        ) : (
          signalContentMobile
        )}
      </article>
    )
  }

  return (
    <tr {...rowProps} className={isOpen ? 'group cursor-pointer' : undefined}>
      <td className={clsx(DESKTOP_TD, openRowCellClass)}>
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channelName}</p>
        {symbol !== '—' ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{symbol}</p>
        ) : null}
      </td>
      <td className={clsx(DESKTOP_TD, openRowCellClass)}>
        {isOpen ? (
          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0 flex-1">{signalContent}</div>
            <Pencil className={EDIT_PEN_ICON} aria-hidden />
          </div>
        ) : (
          signalContent
        )}
      </td>
      <td className={clsx(DESKTOP_TD, 'text-center', openRowCellClass)}>{statusBadge}</td>
      <td className={clsx(DESKTOP_TD, 'text-right text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap', openRowCellClass)}>
        {formattedTime}
      </td>
    </tr>
  )
})

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-6 py-4">
      <p className="text-xs text-neutral-400 mb-1.5">{label}</p>
      <p className="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
    </div>
  )
}
