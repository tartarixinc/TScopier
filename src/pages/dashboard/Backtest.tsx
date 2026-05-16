import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Play,
  Loader2,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  BarChart3,
  Radio,
  Coins,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { backtestApi, type BacktestPreviewResult } from '../../lib/backtestApi'
import type {
  BacktestRunConfig,
  BacktestRunRow,
  BacktestSummary,
  BacktestTradeRow,
  BacktestEquityRow,
} from '../../lib/backtestTypes'
import { BacktestEquityChart } from '../../components/backtest/BacktestEquityChart'
import { BacktestSignalBreakdown } from '../../components/backtest/BacktestSignalBreakdown'
import { BacktestSymbolPicker } from '../../components/backtest/BacktestSymbolPicker'
import { BacktestRunOverlay } from '../../components/backtest/BacktestRunOverlay'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

interface ChannelOption {
  id: string
  display_name: string
}

const OUTCOME_LABELS: Record<string, string> = {
  sl_before_tp: 'SL before TP',
  tp1_then_sl: 'TP1 then SL',
  tp_then_be: 'TP then BE',
  all_tp_hit: 'All TPs hit',
  breakeven: 'Breakeven',
  no_data: 'No market data',
  skipped: 'Skipped',
  open: 'Still open',
}

function defaultConfig(): BacktestRunConfig {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 30)
  return {
    channelIds: [],
    symbols: [],
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    timeframe: '1m',
    executionMode: 'minute_bars',
    initialBalance: 10_000,
    currency: 'USD',
    sizingMode: 'fixed_lot',
    fixedLot: 0.1,
    riskPercent: 1,
    strategy: {
      breakevenAfterTp: 1,
      partialClosePerTp: 0,
      intrabarPriority: 'sl_first',
    },
  }
}

function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'good' | 'bad'
}) {
  const valueClass =
    tone === 'good' ? 'text-teal-600' : tone === 'bad' ? 'text-error-600' : 'text-neutral-900 dark:text-neutral-50'
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className={clsx('text-xl font-semibold mt-1 tabular-nums', valueClass)}>{value}</p>
      {sub ? <p className="text-xs text-neutral-500 mt-0.5">{sub}</p> : null}
    </div>
  )
}

export function Backtest() {
  const t = useT()
  const { user } = useAuth()
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [config, setConfig] = useState<BacktestRunConfig>(defaultConfig)
  const [runs, setRuns] = useState<BacktestRunRow[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [trades, setTrades] = useState<BacktestTradeRow[]>([])
  const [equity, setEquity] = useState<BacktestEquityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<BacktestPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const activeRun = useMemo(
    () => runs.find(r => r.id === activeRunId) ?? null,
    [runs, activeRunId],
  )
  const summary = activeRun?.summary as BacktestSummary | null | undefined

  const isCollatingResults =
    running
    || activeRun?.status === 'running'
    || activeRun?.status === 'pending'

  const collatingMessage = running && activeRun?.status !== 'running'
    ? 'Starting backtest and importing Telegram signals…'
    : activeRun?.progress_message

  const loadChannels = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('telegram_channels')
      .select('id, display_name')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('display_name')
    setChannels((data ?? []) as ChannelOption[])
  }, [user])

  const loadRuns = useCallback(async () => {
    try {
      const { runs: list } = await backtestApi.listRuns()
      setRuns(list)
      if (!activeRunId && list[0]) setActiveRunId(list[0].id)
    } catch {
      /* first visit */
    }
  }, [activeRunId])

  const loadRunDetail = useCallback(async (runId: string) => {
    const { run, trades: t, equity: e } = await backtestApi.getRun(runId)
    setRuns(prev => {
      const idx = prev.findIndex(r => r.id === runId)
      if (idx < 0) return [run, ...prev]
      const next = [...prev]
      next[idx] = run
      return next
    })
    setTrades(t)
    setEquity(e)
  }, [])

  useEffect(() => {
    if (!user) return
    void (async () => {
      setLoading(true)
      await Promise.all([loadChannels(), loadRuns()])
      setLoading(false)
    })()
  }, [user, loadChannels, loadRuns])

  useEffect(() => {
    if (!activeRunId) return
    void loadRunDetail(activeRunId).catch(() => {})
  }, [activeRunId, loadRunDetail])

  useEffect(() => {
    if (!user || !activeRunId) return
    const ch = supabase
      .channel(`backtest-run-${activeRunId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'backtest_runs', filter: `id=eq.${activeRunId}` },
        () => { void loadRunDetail(activeRunId) },
      )
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [user, activeRunId, loadRunDetail])

  useEffect(() => {
    const run = activeRun
    if (!run || run.status !== 'running') return
    const t = window.setInterval(() => { void loadRunDetail(run.id) }, 3000)
    return () => clearInterval(t)
  }, [activeRun, loadRunDetail])

  useEffect(() => {
    if (config.channelIds.length === 0) {
      setPreview(null)
      return
    }
    const t = window.setTimeout(() => {
      setPreviewLoading(true)
      backtestApi
        .preview(config)
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false))
    }, 400)
    return () => clearTimeout(t)
  }, [config.channelIds, config.dateFrom, config.dateTo, config.symbols])

  const toggleChannel = (id: string) => {
    setConfig(prev => ({
      ...prev,
      channelIds: prev.channelIds.includes(id)
        ? prev.channelIds.filter(c => c !== id)
        : [...prev.channelIds, id],
    }))
  }

  const runBacktest = async () => {
    setError('')
    if (config.channelIds.length === 0) {
      setError('Select at least one signal channel')
      return
    }
    setRunning(true)
    try {
      const { run_id } = await backtestApi.createRun(
        `Backtest ${config.dateFrom} → ${config.dateTo}`,
        config,
      )
      setActiveRunId(run_id)
      await loadRuns()
      await loadRunDetail(run_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed')
    } finally {
      setRunning(false)
    }
  }

  const outcomeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of trades) {
      m.set(t.outcome, (m.get(t.outcome) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [trades])

  const channelNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const ch of channels) map[ch.id] = ch.display_name
    if (summary?.byChannel) {
      for (const [id, ch] of Object.entries(summary.byChannel)) {
        if (ch.channelName) map[id] = ch.channelName
      }
    }
    return map
  }, [channels, summary?.byChannel])

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-4">
        <div className="h-10 w-48 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
        <div className="h-64 bg-neutral-100 dark:bg-neutral-800 rounded-xl animate-pulse" />
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-8 max-w-6xl mx-auto space-y-6">
      <BacktestRunOverlay
        open={isCollatingResults}
        message={collatingMessage}
        progressPct={activeRun?.progress_pct}
      />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50 flex items-center gap-2">
            {t.backtest.title}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1 max-w-xl">{t.backtest.subtitle}</p>
        </div>
        {import.meta.env.VITE_BACKTEST_ENABLED === 'false' ? (
          <span className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 rounded-lg">
            {t.common.preview}
          </span>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="grid lg:grid-cols-5 gap-6 min-w-0">
        {/* Config panel */}
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 flex items-center gap-2">
              <Radio className="w-4 h-4 text-teal-500" />
              {t.backtest.channels}
            </h2>
            <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto">
              {channels.length === 0 ? (
                <p className="text-xs text-neutral-400">{t.backtest.noActiveChannels}</p>
              ) : (
                channels.map(ch => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => toggleChannel(ch.id)}
                    className={clsx(
                      'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
                      config.channelIds.includes(ch.id)
                        ? 'bg-teal-50 border-teal-300 text-teal-800 dark:bg-teal-950/50 dark:border-teal-700 dark:text-teal-200'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400',
                    )}
                  >
                    {ch.display_name || 'Unnamed'}
                  </button>
                ))
              )}
            </div>

            {config.channelIds.length > 0 ? (
              <div className="space-y-2 border-t border-neutral-100 dark:border-neutral-800 pt-4">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-teal-500" />
                  {t.backtest.symbols}
                </h2>
                <BacktestSymbolPicker
                  availableSymbols={preview?.available_symbols ?? []}
                  selected={config.symbols}
                  onChange={symbols => setConfig(p => ({ ...p, symbols }))}
                  disabled={previewLoading}
                />
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.from}</span>
                <input
                  type="date"
                  value={config.dateFrom}
                  onChange={e => setConfig(p => ({ ...p, dateFrom: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.to}</span>
                <input
                  type="date"
                  value={config.dateTo}
                  onChange={e => setConfig(p => ({ ...p, dateTo: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.timeframe}</span>
                <select
                  value={config.timeframe}
                  onChange={e => setConfig(p => ({ ...p, timeframe: e.target.value as BacktestRunConfig['timeframe'] }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                >
                  <option value="1m">1 minute</option>
                  <option value="5m">5 minutes</option>
                  <option value="15m">15 minutes</option>
                  <option value="1h">1 hour</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.execution}</span>
                <select
                  value={config.executionMode}
                  onChange={e => setConfig(p => ({ ...p, executionMode: e.target.value as BacktestRunConfig['executionMode'] }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                >
                  <option value="tick_quotes">{t.backtest.executionTick}</option>
                  <option value="minute_bars">{t.backtest.executionBars}</option>
                </select>
              </label>
            </div>

            <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase text-neutral-400 flex items-center gap-1">
                <Shield className="w-3.5 h-3.5" /> {t.backtest.strategy}
              </h3>
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{t.backtest.breakevenAfterTp}</span>
                <select
                  value={config.strategy.breakevenAfterTp}
                  onChange={e => setConfig(p => ({
                    ...p,
                    strategy: { ...p.strategy, breakevenAfterTp: Number(e.target.value) },
                  }))}
                  className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                >
                  <option value={0}>{t.backtest.breakevenDisabled}</option>
                  <option value={1}>TP1</option>
                  <option value={2}>TP2</option>
                  <option value={3}>TP3</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{t.backtest.intrabarPriority}</span>
                <select
                  value={config.strategy.intrabarPriority}
                  onChange={e => setConfig(p => ({
                    ...p,
                    strategy: { ...p.strategy, intrabarPriority: e.target.value as 'sl_first' | 'tp_first' },
                  }))}
                  className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                >
                  <option value="sl_first">{t.backtest.intrabarSlFirst}</option>
                  <option value="tp_first">{t.backtest.intrabarTpFirst}</option>
                </select>
              </label>
            </div>

            <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase text-neutral-400 flex items-center gap-1">
                <Target className="w-3.5 h-3.5" /> {t.backtest.account}
              </h3>
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.startingBalance}</span>
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={config.initialBalance}
                  onChange={e => setConfig(p => ({ ...p, initialBalance: Number(e.target.value) }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">{t.backtest.sizing}</span>
                <select
                  value={config.sizingMode}
                  onChange={e => setConfig(p => ({ ...p, sizingMode: e.target.value as BacktestRunConfig['sizingMode'] }))}
                  className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                >
                  <option value="fixed_lot">{t.backtest.sizingFixed}</option>
                  <option value="risk_percent">{t.backtest.sizingRisk}</option>
                </select>
              </label>
              {config.sizingMode === 'fixed_lot' ? (
                <label className="block">
                  <span className="text-xs text-neutral-500">{t.backtest.lotSize}</span>
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={config.fixedLot}
                    onChange={e => setConfig(p => ({ ...p, fixedLot: Number(e.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="text-xs text-neutral-500">{t.backtest.riskPercent}</span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={config.riskPercent}
                    onChange={e => setConfig(p => ({ ...p, riskPercent: Number(e.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm"
                  />
                </label>
              )}
            </div>

            {config.channelIds.length > 0 ? (
              <div className="rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/40 px-3 py-2.5 text-xs space-y-1">
                {previewLoading ? (
                  <p className="text-neutral-400">Checking signal history…</p>
                ) : preview ? (
                  <>
                    <p className="font-medium text-neutral-700 dark:text-neutral-200">
                      {preview.tradeable_count} tradeable signal{preview.tradeable_count === 1 ? '' : 's'} in range
                      {config.symbols.length > 0
                        ? ` (${config.symbols.join(', ')})`
                        : preview.available_symbols?.length
                          ? ` · ${preview.available_symbols.length} symbol${preview.available_symbols.length === 1 ? '' : 's'} in channel`
                          : ''}
                    </p>
                    <p className="text-neutral-500">
                      {preview.stored_count} stored in backtest table (copier logs not used)
                    </p>
                    {!preview.massive_configured ? (
                      <p className="text-amber-600 dark:text-amber-400">
                        MASSIVE_API_KEY is not set in Supabase Edge secrets — market data will not load.
                      </p>
                    ) : (
                      <p className="text-teal-600 dark:text-teal-400">
                        Massive API key configured
                        {preview.massive_calls_per_minute
                          ? ` · ${preview.massive_calls_per_minute} calls/min limit (OHLC bars recommended)`
                          : ''}
                        .
                        {preview.massive_probe ? (
                          preview.massive_probe.ok
                            ? ` Probe OK (${preview.massive_probe.bars ?? 0} bars).`
                            : ` Probe: ${preview.massive_probe.error ?? 'failed'}.`
                        ) : (
                          ' Market data loads when you run a backtest.'
                        )}
                      </p>
                    )}
                    {config.executionMode === 'tick_quotes' && (preview.massive_calls_per_minute ?? 5) <= 5 ? (
                      <p className="text-amber-600 dark:text-amber-400">
                        Tick quotes use many API calls. On a 5/min plan the engine uses OHLC bars instead.
                      </p>
                    ) : null}
                    {preview.tradeable_count === 0 ? (
                      <p className="text-neutral-500">
                        Running a backtest imports Telegram history for your date range (worker must be online).
                        Ensure Telegram is connected, channels are active, and messages parse as buy/sell with entry and SL or TP.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-neutral-400">Could not load signal preview</p>
                )}
              </div>
            ) : null}

            <Button
              className="w-full"
              onClick={() => { void runBacktest() }}
              disabled={running || config.channelIds.length === 0}
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {t.backtest.runBacktest}
            </Button>
          </div>

          {runs.length > 0 ? (
            <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
              <p className="text-xs font-medium text-neutral-400 mb-2">{t.backtest.recentRuns}</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {runs.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setActiveRunId(r.id)}
                    className={clsx(
                      'w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors',
                      activeRunId === r.id
                        ? 'bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200'
                        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800',
                    )}
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="ml-2 text-neutral-400">{r.status}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Results */}
        <div className="lg:col-span-3 space-y-4 min-w-0">
          {activeRun?.status === 'failed' ? (
            <Alert variant="error">{activeRun.error_message ?? 'Backtest failed'}</Alert>
          ) : null}
          {activeRun?.progress_message && activeRun.status !== 'failed' && !isCollatingResults ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{activeRun.progress_message}</p>
          ) : null}
          {summary?.massiveApiCalls != null && activeRun?.status === 'completed' ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Massive API: {summary.massiveApiCalls} request{summary.massiveApiCalls === 1 ? '' : 's'}
              {summary.massiveApiCalls === 0
                ? ' — no market data was fetched (zero tradeable signals or run did not reach simulation)'
                : ''}
            </p>
          ) : null}
          {summary?.importWarnings && summary.importWarnings.length > 0 ? (
            <Alert variant="warning">
              Import: {summary.importWarnings.slice(0, 2).join(' · ')}
              {summary.importWarnings.length > 2 ? ` (+${summary.importWarnings.length - 2} more)` : ''}
            </Alert>
          ) : null}
          {summary?.message && (summary.totalSignals ?? 0) === 0 ? (
            <Alert variant="warning">{summary.message}</Alert>
          ) : null}

          {summary ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Return"
                  value={`${summary.returnPct >= 0 ? '+' : ''}${summary.returnPct}%`}
                  tone={summary.returnPct >= 0 ? 'good' : 'bad'}
                />
                <StatCard label="Final equity" value={`$${summary.finalEquity.toLocaleString()}`} />
                <StatCard label="Max DD" value={`${summary.maxDrawdownPct}%`} tone="bad" />
                <StatCard label="Win rate" value={`${summary.winRate}%`} />
                <StatCard label="TP1 → BE" value={String(summary.tp1BeforeBe)} sub="Hit TP1 then breakeven" />
                <StatCard label="TP1 → SL" value={String(summary.tp1BeforeSl)} sub="Hit TP1 then stopped" />
                <StatCard label="All TPs" value={String(summary.allTpHits)} />
                <StatCard
                  label="Profit factor"
                  value={summary.profitFactor != null ? String(summary.profitFactor) : '—'}
                />
              </div>

              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-3 flex items-center gap-2">
                  {summary.netPnl >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-teal-500" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-error-500" />
                  )}
                  Equity curve
                </h2>
                <BacktestEquityChart equity={equity} />
              </div>

              {Object.keys(summary.byChannel ?? {}).length > 0 ? (
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
                  <h2 className="text-sm font-semibold mb-3">Channel leaderboard</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-neutral-400 border-b border-neutral-100 dark:border-neutral-800">
                          <th className="pb-2">Channel</th>
                          <th className="pb-2">Trades</th>
                          <th className="pb-2">Net P/L</th>
                          <th className="pb-2">Win %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(summary.byChannel).map(([id, ch]) => (
                          <tr key={id} className="border-b border-neutral-50 dark:border-neutral-800/80">
                            <td className="py-2 font-medium">{ch.channelName}</td>
                            <td className="py-2 tabular-nums">{ch.trades}</td>
                            <td className={clsx('py-2 tabular-nums font-medium', ch.netPnl >= 0 ? 'text-teal-600' : 'text-error-600')}>
                              ${ch.netPnl.toFixed(2)}
                            </td>
                            <td className="py-2 tabular-nums">{ch.winRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {outcomeCounts.length > 0 ? (
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
                  <h2 className="text-sm font-semibold mb-3">Outcome distribution</h2>
                  <div className="flex flex-wrap gap-2">
                    {outcomeCounts.map(([k, n]) => (
                      <span
                        key={k}
                        className="px-2.5 py-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-xs font-medium"
                      >
                        {OUTCOME_LABELS[k] ?? k}: {n}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-neutral-200 dark:border-neutral-700 py-16 text-center">
              <BarChart3 className="w-10 h-10 mx-auto text-neutral-300 dark:text-neutral-600 mb-3" />
              <p className="text-sm text-neutral-500">Configure channels and run your first backtest</p>
            </div>
          )}

          {trades.length > 0 ? (
            <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
              <div className="px-5 py-3 border-b border-neutral-100 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  {t.backtest.signalBreakdown}
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  {trades.length} simulated signal{trades.length === 1 ? '' : 's'} · grouped by month
                </p>
              </div>
              <div className="max-h-[32rem] overflow-y-auto">
                <BacktestSignalBreakdown trades={trades} channelNames={channelNames} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
