import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Crosshair,
  History,
  Loader2,
  Radio,
  RefreshCw,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { interpolate } from '../../i18n/interpolate'
import { useT } from '../../context/LocaleContext'
import { backtestApi, loadBacktestRunFromDb, waitForBacktestRunComplete, waitForSignalSyncComplete } from '../../lib/backtestApi'
import type {
  BacktestRunRow,
  BacktestTradeRow,
  SimpleBacktestConfig,
  StoredBacktestSignal,
} from '../../lib/backtestTypes'
import { buildSymbolProfiles } from '../../components/backtest/ProfileSignalsPanel'
import { BacktestResultsList } from '../../components/backtest/BacktestResultsList'
import { BacktestResultModal } from '../../components/backtest/BacktestResultModal'
import {
  BacktestHistoryModal,
  type BacktestHistoryRow,
} from '../../components/backtest/BacktestHistoryModal'
import { backtestDateRangeIso } from '../../lib/backtestDateRange'
import {
  filterImportPreviewErrors,
  formatPipValue,
  parseSummary,
  sanitizeBacktestUserError,
  tradePipPnl,
} from '../../lib/backtestDisplay'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useSubscription } from '../../context/SubscriptionContext'
import { PaywallErrorAlert } from '../../components/billing/PaywallErrorAlert'
import { UpgradePrompt } from '../../components/billing/UpgradePrompt'

interface ChannelOption {
  id: string
  display_name: string
}

type FlowStep = 'configure' | 'symbol' | 'results'

function defaultDateRange(): { dateFrom: string; dateTo: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 30)
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
  }
}

function buildConfig(
  channelId: string,
  dateFrom: string,
  dateTo: string,
  symbols?: string[],
): SimpleBacktestConfig {
  return {
    channelIds: [channelId],
    dateFrom,
    dateTo,
    initialBalance: 10_000,
    fixedLot: 0.1,
    timeframe: '5m',
    ...(symbols?.length ? { symbols } : {}),
  }
}


export function Backtest() {
  const t = useT()
  const bt = t.backtest
  const pw = t.pricing.paywall
  const { user } = useAuth()
  const {
    hasActiveSubscription,
    canRunBacktest,
    limits,
    refresh: refreshSubscription,
    loading: subscriptionLoading,
    isAdmin,
  } = useSubscription()

  const hasBacktestAccess = isAdmin || (hasActiveSubscription && canRunBacktest())
  const defaultDates = useMemo(() => defaultDateRange(), [])
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(defaultDates.dateFrom)
  const [dateTo, setDateTo] = useState(defaultDates.dateTo)
  const [profiledSignals, setProfiledSignals] = useState<StoredBacktestSignal[]>([])
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [profileNote, setProfileNote] = useState('')
  const [profiling, setProfiling] = useState(false)
  const [profileProgress, setProfileProgress] = useState({ pct: 0, message: '' })
  const [profileKey, setProfileKey] = useState('')
  const [step, setStep] = useState<FlowStep>('configure')
  const [activeRun, setActiveRun] = useState<BacktestRunRow | null>(null)
  const [trades, setTrades] = useState<BacktestTradeRow[]>([])
  const [selectedTrade, setSelectedTrade] = useState<BacktestTradeRow | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingHistoryRun, setLoadingHistoryRun] = useState(false)
  const activeRunTokenRef = useRef(0)

  const summary = parseSummary(activeRun?.summary)
  const isBacktestActive = running || activeRun?.status === 'running' || activeRun?.status === 'pending'
  const isBusy = profiling || isBacktestActive

  const symbolProfiles = useMemo(
    () => buildSymbolProfiles(profiledSignals),
    [profiledSignals],
  )

  const selectionKey = `${selectedChannelId ?? ''}|${dateFrom}|${dateTo}`
  const hasValidProfile =
    profileKey === selectionKey && profiledSignals.length > 0 && Boolean(selectedChannelId)

  const channelName = channels.find(c => c.id === selectedChannelId)?.display_name ?? bt.channelFallback

  const channelNameMap = useMemo(
    () => new Map(channels.map(c => [c.id, c.display_name])),
    [channels],
  )

  const totalPips = useMemo(() => {
    if (summary?.totalPips != null && Number.isFinite(summary.totalPips)) {
      return summary.totalPips
    }
    let sum = 0
    let hasAny = false
    for (const tr of trades) {
      const p = tradePipPnl(tr)
      if (p == null) continue
      sum += p
      hasAny = true
    }
    return hasAny ? sum : null
  }, [summary?.totalPips, trades])

  const loadStoredSignals = useCallback(async (channelId: string, from: string, to: string) => {
    if (!user) return []
    const { fromIso, toIso } = backtestDateRangeIso(from, to)
    const { data, error: qErr } = await supabase
      .from('backtest_channel_signals')
      .select('id, channel_id, symbol, direction, entry_price, sl, tp_levels, signal_at, source')
      .eq('user_id', user.id)
      .eq('channel_id', channelId)
      .gte('signal_at', fromIso)
      .lte('signal_at', toIso)
      .order('signal_at', { ascending: false })
    if (qErr) throw new Error(qErr.message)
    return (data ?? []) as StoredBacktestSignal[]
  }, [user])

  const applyRunResult = useCallback((run: BacktestRunRow, loaded: BacktestTradeRow[]) => {
    setActiveRun(run)
    setTrades(loaded)
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      setRunning(false)
    }
    return run
  }, [])

  const loadRun = useCallback(async (runId: string) => {
    if (!user?.id) throw new Error('Not signed in')
    const { run, trades: loaded } = await loadBacktestRunFromDb(runId, user.id)
    return applyRunResult(run, loaded)
  }, [user?.id, applyRunResult])

  const clearResults = useCallback(() => {
    setActiveRun(null)
    setTrades([])
    setSelectedTrade(null)
  }, [])

  const prevSelectionKey = useRef(selectionKey)
  const runningRef = useRef(false)
  runningRef.current = running
  useEffect(() => {
    if (prevSelectionKey.current === selectionKey) return
    prevSelectionKey.current = selectionKey
    setProfiledSignals([])
    setSelectedSymbol(null)
    setProfileNote('')
    setProfileKey('')
    clearResults()
    if (!runningRef.current) {
      setStep('configure')
    }
  }, [selectionKey, clearResults])

  useEffect(() => {
    if (!user) return
    void (async () => {
      const { data } = await supabase
        .from('telegram_channels')
        .select('id, display_name')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('display_name')
      setChannels((data ?? []).map(r => ({
        id: r.id as string,
        display_name: (r.display_name as string) || bt.channelFallback,
      })))
    })()
  }, [user, bt.channelFallback])

  const userError = useCallback((e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e)
    if (/active subscription is required/i.test(raw)) {
      return pw.subscriptionRequired
    }
    return sanitizeBacktestUserError(raw, bt.errors.rateLimit)
  }, [pw.subscriptionRequired, bt.errors.rateLimit])

  const resultReady = step === 'symbol' && activeRun?.status === 'completed' && !running
  const showResults = useCallback(() => setStep('results'), [])

  const profileSignals = async () => {
    if (!user?.id) return
    if (!selectedChannelId) {
      setError(bt.selectChannelError)
      return
    }
    setError('')
    setProfileNote('')
    setProfiledSignals([])
    setSelectedSymbol(null)
    setProfileKey('')
    clearResults()
    setProfiling(true)
    setProfileProgress({ pct: 0, message: bt.pullingSignals })
    try {
      const config = buildConfig(selectedChannelId, dateFrom, dateTo)
      const { sync_run_id } = await backtestApi.sync(config)
      const result = await waitForSignalSyncComplete(sync_run_id, user.id, {
        onTick: (run) => {
          setProfileProgress({
            pct: Number(run.progress_pct ?? 0),
            message: run.progress_message ?? bt.pullingSignals,
          })
        },
      })
      let signals = await loadStoredSignals(selectedChannelId, dateFrom, dateTo)
      if (signals.length === 0 && result.imported > 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, 400))
          signals = await loadStoredSignals(selectedChannelId, dateFrom, dateTo)
          if (signals.length > 0) break
        }
      }
      setProfiledSignals(signals)
      setProfileKey(`${selectedChannelId}|${dateFrom}|${dateTo}`)
      const msg = result.imported > 0
        ? interpolate(bt.profileImported, {
            imported: String(result.imported),
            scanned: String(result.messages_scanned),
          })
        : result.candidates > 0
          ? interpolate(bt.profileCandidates, { candidates: String(result.candidates) })
          : interpolate(bt.profileNoTradeable, { scanned: String(result.messages_scanned) })
      const syncErrors = filterImportPreviewErrors(result.errors)
      setProfileNote([msg, ...syncErrors].filter(Boolean).join(' '))
      if (syncErrors.length > 0 && result.imported === 0 && signals.length === 0) {
        setError(syncErrors.join(' · ') || bt.profileSyncFailed)
      }
      const profiles = buildSymbolProfiles(signals)
      if (profiles.length > 0) {
        setSelectedSymbol(profiles[0]?.symbol ?? null)
      } else {
        setSelectedSymbol(null)
      }
      setStep('symbol')
    } catch (e) {
      setError(userError(e))
    } finally {
      setProfiling(false)
      setProfileProgress({ pct: 0, message: '' })
    }
  }

  const startBacktest = async () => {
    if (!user?.id) return
    if (!selectedChannelId || !hasValidProfile || !selectedSymbol) {
      setError(!hasValidProfile ? bt.profileFirstError : bt.selectSymbolError)
      return
    }
    if (!isAdmin) {
      if (!hasActiveSubscription) {
        setError(pw.subscriptionRequired)
        return
      }
      if (!canRunBacktest()) {
        setError(interpolate(pw.backtestLimit, { limit: String(limits.maxBacktestsPerMonth ?? 5) }))
        return
      }
    }
    const runToken = ++activeRunTokenRef.current
    setError('')
    setRunning(true)
    setSelectedTrade(null)
    setActiveRun(null)
    setTrades([])
    try {
      const config = buildConfig(selectedChannelId, dateFrom, dateTo, [selectedSymbol])
      const { run_id } = await backtestApi.backtestTpsl(config)
      if (runToken !== activeRunTokenRef.current) return

      const { run, trades: finishedTrades } = await waitForBacktestRunComplete(run_id, user.id, {
        onTick: ({ run: tickRun, trades: tickTrades }) => {
          if (runToken !== activeRunTokenRef.current) return
          setActiveRun(tickRun)
          setTrades(tickTrades)
        },
      })
      if (runToken !== activeRunTokenRef.current) return

      setActiveRun(run)
      setTrades(finishedTrades)

      if (run.status === 'completed') {
        setStep('results')
      } else if (run.status === 'failed') {
        setError(
          sanitizeBacktestUserError(run.error_message ?? 'Backtest failed.', bt.errors.rateLimit),
        )
        if (finishedTrades.length > 0) {
          setStep('results')
        }
      }

      void refreshSubscription()
    } catch (e) {
      if (runToken !== activeRunTokenRef.current) return
      setError(userError(e))
    } finally {
      if (runToken === activeRunTokenRef.current) {
        setRunning(false)
      }
    }
  }

  const totalPipsTone = totalPips == null ? 'neutral' : totalPips >= 0 ? 'good' : 'bad'
  const canProfile = Boolean(selectedChannelId) && !isBusy
  const canBacktest = hasValidProfile && Boolean(selectedSymbol) && !isBusy && hasBacktestAccess

  const openHistoryRun = async (row: BacktestHistoryRow) => {
    setHistoryOpen(false)
    setError('')
    setLoadingHistoryRun(true)
    setSelectedTrade(null)
    try {
      const cfg = row.config as SimpleBacktestConfig & { channelIds?: string[]; symbols?: string[] }
      const chId = Array.isArray(cfg.channelIds) ? cfg.channelIds[0] : null
      if (chId) setSelectedChannelId(String(chId))
      if (cfg.dateFrom) setDateFrom(String(cfg.dateFrom))
      if (cfg.dateTo) setDateTo(String(cfg.dateTo))
      const sym = Array.isArray(cfg.symbols) ? cfg.symbols[0] : null
      if (sym) setSelectedSymbol(String(sym).toUpperCase())

      const run = await loadRun(row.id)
      setStep('results')
      if (run.status === 'running' || run.status === 'pending') {
        setRunning(true)
      }
    } catch (e) {
      setError(userError(e))
    } finally {
      setLoadingHistoryRun(false)
    }
  }

  const signalListLabel =
    trades.length === 1
      ? bt.oneSignal
      : interpolate(bt.nSignals, { count: String(trades.length) })

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      {!subscriptionLoading && !hasBacktestAccess ? (
        <UpgradePrompt
          variant="banner"
          reason={
            !hasActiveSubscription
              ? pw.subscriptionRequired
              : interpolate(pw.backtestLimit, { limit: String(limits.maxBacktestsPerMonth ?? 5) })
          }
        />
      ) : null}
      <PageHeader
        title={bt.title}
        subtitle={bt.subtitle}
        actions={(
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => setHistoryOpen(true)}
            disabled={(isBusy && !historyOpen) || loadingHistoryRun}
          >
            {loadingHistoryRun ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <History className="w-4 h-4 mr-2" />
            )}
            {bt.history}
          </Button>
        )}
      />

      {error ? <PaywallErrorAlert message={error} variant="error" /> : null}
      {activeRun?.status === 'failed' && activeRun.error_message ? (
        <Alert variant="error">{sanitizeBacktestUserError(activeRun.error_message, bt.errors.rateLimit)}</Alert>
      ) : null}

      {step === 'configure' ? (
        <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 space-y-6 shadow-sm">
          <div>
            <p className="text-sm text-neutral-500 mt-1">{bt.configureHint}</p>
          </div>

          <div>
            <p className="text-xs font-medium text-neutral-500 mb-2 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5" />
              {bt.signalChannel}
            </p>
            <div className="flex flex-wrap gap-2">
              {channels.length === 0 ? (
                <p className="text-sm text-neutral-400">{bt.noActiveChannels}</p>
              ) : (
                channels.map(ch => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => {
                      setSelectedChannelId(prev => (prev === ch.id ? null : ch.id))
                      setError('')
                    }}
                    disabled={isBusy}
                    className={clsx(
                      'px-3 py-2 rounded-xl text-sm border transition-all disabled:opacity-50',
                      selectedChannelId === ch.id
                        ? 'border-teal-500 bg-teal-500 text-white shadow-sm'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300',
                    )}
                  >
                    {ch.display_name}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs font-medium text-neutral-500">{bt.from}</span>
              <input
                type="date"
                disabled={isBusy}
                className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2.5 text-sm disabled:opacity-50"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-neutral-500">{bt.to}</span>
              <input
                type="date"
                disabled={isBusy}
                className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2.5 text-sm disabled:opacity-50"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
              />
            </label>
          </div>

          <Button className="w-full" onClick={() => void profileSignals()} disabled={!canProfile}>
            {profiling ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {profileProgress.message || bt.pullingSignals}
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                {bt.pullProfileSignals}
                <ArrowRight className="w-4 h-4 ml-2 opacity-70" />
              </>
            )}
          </Button>

          {profiling ? (
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-teal-100 dark:bg-teal-900 overflow-hidden">
                <div
                  className="h-full bg-teal-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(profileProgress.pct, 4))}%` }}
                />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {step === 'symbol' ? (
        <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 space-y-6 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{bt.readyTitle}</h2>
              <p className="text-sm text-neutral-500 mt-1">
                {interpolate(bt.readyMeta, {
                  channel: channelName,
                  count: String(profiledSignals.length),
                  from: dateFrom,
                  to: dateTo,
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStep('configure')}
              className="text-sm text-neutral-500 hover:text-neutral-800 flex items-center gap-1 shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              {bt.back}
            </button>
          </div>

          {profileNote ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400 rounded-xl bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3">
              {profileNote}
            </p>
          ) : null}

          <div>
            <p className="text-xs font-medium text-neutral-500 mb-3">{bt.symbolToBacktest}</p>
            {symbolProfiles.length === 0 ? (
              <p className="text-sm text-neutral-500 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-700 px-4 py-6 text-center">
                {bt.noSymbolsInRange}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {symbolProfiles.map(({ symbol, count }) => (
                  <button
                    key={symbol}
                    type="button"
                    onClick={() => {
                      setSelectedSymbol(symbol)
                      clearResults()
                    }}
                    className={clsx(
                      'px-4 py-2.5 rounded-xl text-sm font-medium border transition-all',
                      selectedSymbol === symbol
                        ? 'border-teal-500 bg-teal-500 text-white shadow-md shadow-teal-500/20'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-teal-300',
                    )}
                  >
                    {symbol}
                    <span className={clsx('ml-2 tabular-nums text-xs', selectedSymbol === symbol ? 'opacity-90' : 'opacity-60')}>
                      {count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {resultReady ? (
            <div className="space-y-3 rounded-xl border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4">
              <p className="text-sm text-teal-800 dark:text-teal-200">{bt.resultReady}</p>
              <Button className="w-full" onClick={showResults}>
                <BarChart3 className="w-4 h-4 mr-2" />
                {bt.seeBacktestResult}
              </Button>
            </div>
          ) : isBacktestActive ? (
            <div className="space-y-3 rounded-xl border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4">
              <div className="flex items-center gap-2 text-sm text-teal-800 dark:text-teal-200">
                <Loader2 className="w-4 h-4 animate-spin" />
                {activeRun?.progress_message ?? bt.runningDefault}
              </div>
              {activeRun?.progress_pct != null ? (
                <div className="h-2 rounded-full bg-teal-100 dark:bg-teal-900 overflow-hidden">
                  <div
                    className="h-full bg-teal-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, activeRun.progress_pct)}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <Button className="w-full" onClick={() => void startBacktest()} disabled={!canBacktest}>
              <Crosshair className="w-4 h-4 mr-2" />
              {bt.runBacktest}{selectedSymbol ? ` · ${selectedSymbol}` : ''}
            </Button>
          )}
        </section>
      ) : null}

      {step === 'results' ? (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{bt.resultsTitle}</h2>
              <p className="text-sm text-neutral-500 mt-0.5">
                {interpolate(bt.resultsSubtitle, {
                  symbol: selectedSymbol ?? '—',
                  channel: channelName,
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setStep('symbol')
                clearResults()
              }}
              className="text-sm text-neutral-500 hover:text-neutral-800 flex items-center gap-1"
            >
              <ArrowLeft className="w-4 h-4" />
              {bt.newRun}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 col-span-2 sm:col-span-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{bt.totalPips}</p>
              <p
                className={clsx(
                  'text-3xl font-bold tabular-nums mt-1',
                  totalPipsTone === 'good' && 'text-teal-600',
                  totalPipsTone === 'bad' && 'text-error-600',
                )}
              >
                {formatPipValue(totalPips)}
              </p>
            </div>
            {summary ? (
              <>
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{bt.winRate}</p>
                  <p className="text-2xl font-bold mt-1">{(summary.winRate * 100).toFixed(0)}%</p>
                </div>
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{bt.winLoss}</p>
                  <p className="text-2xl font-bold mt-1 tabular-nums">{summary.wins}/{summary.losses}</p>
                </div>
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{bt.signalsLabel}</p>
                  <p className="text-2xl font-bold mt-1 tabular-nums">{summary.tradedSignals}</p>
                </div>
              </>
            ) : null}
          </div>

          <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden shadow-sm">
            <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {signalListLabel}
              </p>
            </div>
            <BacktestResultsList trades={trades} onSelect={setSelectedTrade} />
          </div>
        </section>
      ) : null}

      <BacktestResultModal
        trade={selectedTrade}
        onClose={() => setSelectedTrade(null)}
        onTradeUpdated={(updated, run) => {
          setTrades(prev => prev.map(t => (t.id === updated.id ? updated : t)))
          if (run) setActiveRun(run)
          setSelectedTrade(updated)
        }}
        onTradeDeleted={(tradeId, run) => {
          setTrades(prev => prev.filter(t => t.id !== tradeId))
          if (run) setActiveRun(run)
          setSelectedTrade(null)
        }}
      />

      <BacktestHistoryModal
        open={historyOpen}
        userId={user?.id}
        channelNames={channelNameMap}
        onClose={() => setHistoryOpen(false)}
        onSelectRun={run => { void openHistoryRun(run) }}
      />
    </PageShell>
  )
}
