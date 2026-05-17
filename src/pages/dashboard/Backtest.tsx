import { useCallback, useEffect, useMemo, useState } from 'react'
import { Play, Loader2, Radio, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { backtestApi } from '../../lib/backtestApi'
import type {
  BacktestEquityRow,
  BacktestRunRow,
  BacktestSummary,
  BacktestTradeRow,
  SimpleBacktestConfig,
  StoredBacktestSignal,
} from '../../lib/backtestTypes'
import { BacktestEquityChart } from '../../components/backtest/BacktestEquityChart'
import { BacktestSignalBreakdown } from '../../components/backtest/BacktestSignalBreakdown'
import { sanitizeBacktestUserError } from '../../lib/backtestDisplay'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

const LAST_RUN_KEY = 'backtest_last_run_id'

interface ChannelOption {
  id: string
  display_name: string
}

function defaultConfig(): SimpleBacktestConfig {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 30)
  return {
    channelIds: [],
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    initialBalance: 10_000,
    fixedLot: 0.1,
    timeframe: '1m',
  }
}

function StoredSignalsPanel({
  config,
  storedSignals,
  storedLoading,
}: {
  config: SimpleBacktestConfig
  storedSignals: StoredBacktestSignal[]
  storedLoading: boolean
}) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            Stored signals
          </p>
          <p className="text-xs text-neutral-500 mt-0.5">
            Table <code className="text-[11px]">backtest_channel_signals</code> for selected channels and dates
          </p>
        </div>
        <span className="text-sm tabular-nums text-neutral-600 dark:text-neutral-300">
          {storedLoading ? '…' : storedSignals.length}
        </span>
      </div>
      {config.channelIds.length === 0 ? (
        <p className="text-sm text-neutral-400">Select a channel to view stored signals.</p>
      ) : storedSignals.length === 0 && !storedLoading ? (
        <p className="text-sm text-neutral-400">
          No rows yet. Use <strong>Sync signals only</strong> or <strong>Run backtest</strong> to import from Telegram.
        </p>
      ) : (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-neutral-500 sticky top-0 bg-white dark:bg-neutral-900">
              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                <th className="text-left py-2 pr-2 font-medium">Time</th>
                <th className="text-left py-2 pr-2 font-medium">Symbol</th>
                <th className="text-left py-2 pr-2 font-medium">Side</th>
                <th className="text-right py-2 pr-2 font-medium">Entry</th>
                <th className="text-right py-2 pr-2 font-medium">SL</th>
                <th className="text-left py-2 font-medium">TPs</th>
              </tr>
            </thead>
            <tbody>
              {storedSignals.map(row => (
                <tr key={row.id} className="border-b border-neutral-50 dark:border-neutral-800/80">
                  <td className="py-1.5 pr-2 whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                    {new Date(row.signal_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-1.5 pr-2 font-medium">{row.symbol}</td>
                  <td className={clsx('py-1.5 pr-2 uppercase', row.direction === 'buy' ? 'text-teal-600' : 'text-error-600')}>
                    {row.direction}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {row.entry_price > 0 ? row.entry_price : 'MKT'}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.sl ?? '—'}</td>
                  <td className="py-1.5 tabular-nums">
                    {(row.tp_levels ?? []).length ? row.tp_levels.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
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
  const [config, setConfig] = useState<SimpleBacktestConfig>(defaultConfig)
  const [activeRun, setActiveRun] = useState<BacktestRunRow | null>(null)
  const [trades, setTrades] = useState<BacktestTradeRow[]>([])
  const [equity, setEquity] = useState<BacktestEquityRow[]>([])
  const [running, setRunning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [storedSignals, setStoredSignals] = useState<StoredBacktestSignal[]>([])
  const [storedLoading, setStoredLoading] = useState(false)
  const [syncNote, setSyncNote] = useState('')
  const [error, setError] = useState('')

  const summary = activeRun?.summary as BacktestSummary | null | undefined
  const isActive = running || activeRun?.status === 'running' || activeRun?.status === 'pending'

  const channelNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const ch of channels) m[ch.id] = ch.display_name
    return m
  }, [channels])

  const noDataCount = useMemo(
    () => trades.filter(tr => tr.outcome === 'no_data').length,
    [trades],
  )

  const loadStoredSignals = useCallback(async () => {
    if (!user || config.channelIds.length === 0) {
      setStoredSignals([])
      return
    }
    setStoredLoading(true)
    const fromIso = new Date(config.dateFrom).toISOString()
    const toIso = new Date(`${config.dateTo}T23:59:59.999Z`).toISOString()
    const { data, error: qErr } = await supabase
      .from('backtest_channel_signals')
      .select('id, channel_id, symbol, direction, entry_price, sl, tp_levels, signal_at, source')
      .eq('user_id', user.id)
      .in('channel_id', config.channelIds)
      .gte('signal_at', fromIso)
      .lte('signal_at', toIso)
      .order('signal_at', { ascending: false })
    setStoredLoading(false)
    if (qErr) {
      setSyncNote(qErr.message)
      return
    }
    setStoredSignals((data ?? []) as StoredBacktestSignal[])
  }, [user, config.channelIds, config.dateFrom, config.dateTo])

  const loadRun = useCallback(async (runId: string) => {
    const { run, trades: t, equity: e } = await backtestApi.getRun(runId)
    setActiveRun(run)
    setTrades(t)
    setEquity(e)
    return run
  }, [])

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
        display_name: (r.display_name as string) || 'Channel',
      })))
      const lastId = localStorage.getItem(LAST_RUN_KEY)
      if (lastId) {
        try {
          await loadRun(lastId)
        } catch {
          localStorage.removeItem(LAST_RUN_KEY)
        }
      }
    })()
  }, [user, loadRun])

  useEffect(() => {
    const t = setTimeout(() => { void loadStoredSignals() }, 400)
    return () => clearTimeout(t)
  }, [loadStoredSignals])

  useEffect(() => {
    if (!isActive) return
    const t = setInterval(() => { void loadStoredSignals() }, 4000)
    return () => clearInterval(t)
  }, [isActive, loadStoredSignals])

  useEffect(() => {
    if (!activeRun?.id || !isActive) return
    const runId = activeRun.id
    const poll = setInterval(() => {
      void loadRun(runId).then(run => {
        void loadStoredSignals()
        if (run.status === 'completed' || run.status === 'failed') {
          setRunning(false)
        }
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(poll)
  }, [activeRun?.id, isActive, loadRun])

  useEffect(() => {
    if (!activeRun?.id || !isActive) return
    const ch = supabase
      .channel(`backtest-run-${activeRun.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'backtest_runs',
          filter: `id=eq.${activeRun.id}`,
        },
        () => { void loadRun(activeRun.id) },
      )
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [activeRun?.id, isActive, loadRun])

  const toggleChannel = (id: string) => {
    setConfig(prev => ({
      ...prev,
      channelIds: prev.channelIds.includes(id)
        ? prev.channelIds.filter(c => c !== id)
        : [...prev.channelIds, id],
    }))
  }

  const handleSyncOnly = async () => {
    if (config.channelIds.length === 0) {
      setError('Select at least one channel')
      return
    }
    setError('')
    setSyncNote('')
    setSyncing(true)
    try {
      const result = await backtestApi.sync(config)
      const msg = result.imported > 0
        ? `Stored ${result.imported} signal(s) in backtest_channel_signals (${result.candidates} candidates, ${result.messages_scanned} messages scanned).`
        : 'No tradeable signals stored.'
      setSyncNote([msg, ...result.errors].filter(Boolean).join(' '))
      await loadStoredSignals()
    } catch (e) {
      setError(sanitizeBacktestUserError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
    }
  }

  const handleRun = async () => {
    if (config.channelIds.length === 0) {
      setError('Select at least one channel')
      return
    }
    setError('')
    setRunning(true)
    setTrades([])
    setEquity([])
    try {
      const { run_id } = await backtestApi.run(config)
      localStorage.setItem(LAST_RUN_KEY, run_id)
      const run = await loadRun(run_id)
      if (run.status === 'completed' || run.status === 'failed') {
        setRunning(false)
        void loadStoredSignals()
      }
    } catch (e) {
      setError(sanitizeBacktestUserError(e instanceof Error ? e.message : String(e)))
      setRunning(false)
    }
  }

  const statusLine = activeRun?.progress_message
    ?? (running ? 'Starting backtest…' : null)

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          {t.backtest.title}
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          Sync Telegram signals, simulate TP/SL outcomes.
        </p>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {activeRun?.status === 'failed' && activeRun.error_message ? (
        <Alert variant="error">{sanitizeBacktestUserError(activeRun.error_message)}</Alert>
      ) : null}

      <div className="grid lg:grid-cols-[minmax(280px,340px)_1fr] gap-6">
        <div className="space-y-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <div>
            <p className="text-xs font-medium text-neutral-500 mb-2 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5" />
              Channels
            </p>
            <div className="flex flex-wrap gap-2">
              {channels.length === 0 ? (
                <p className="text-sm text-neutral-400">No active Telegram channels</p>
              ) : (
                channels.map(ch => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => toggleChannel(ch.id)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-sm border transition-colors',
                      config.channelIds.includes(ch.id)
                        ? 'border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300',
                    )}
                  >
                    {ch.display_name}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-neutral-500">From</span>
              <input
                type="date"
                className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
                value={config.dateFrom}
                onChange={e => setConfig(c => ({ ...c, dateFrom: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">To</span>
              <input
                type="date"
                className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
                value={config.dateTo}
                onChange={e => setConfig(c => ({ ...c, dateTo: e.target.value }))}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-neutral-500">Starting balance (USD)</span>
            <input
              type="number"
              min={100}
              step={100}
              className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              value={config.initialBalance}
              onChange={e => setConfig(c => ({ ...c, initialBalance: Number(e.target.value) }))}
            />
          </label>

          <label className="block">
            <span className="text-xs text-neutral-500">Lot size</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              className="mt-1 w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              value={config.fixedLot}
              onChange={e => setConfig(c => ({ ...c, fixedLot: Number(e.target.value) }))}
            />
          </label>

          <Button
            variant="secondary"
            className="w-full"
            onClick={() => void handleSyncOnly()}
            disabled={isActive || syncing || config.channelIds.length === 0}
          >
            {syncing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Syncing Telegram…
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Sync signals only
              </>
            )}
          </Button>

          <Button
            className="w-full"
            onClick={() => void handleRun()}
            disabled={isActive || syncing || config.channelIds.length === 0}
          >
            {isActive ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Running…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                {t.backtest.runBacktest}
              </>
            )}
          </Button>

          {syncNote ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-300">{syncNote}</p>
          ) : null}
          {statusLine ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{statusLine}</p>
          ) : null}
          {isActive && activeRun?.progress_pct != null ? (
            <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
              <div
                className="h-full bg-teal-500 transition-all duration-500"
                style={{ width: `${Math.min(100, activeRun.progress_pct)}%` }}
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <StoredSignalsPanel
            config={config}
            storedSignals={storedSignals}
            storedLoading={storedLoading}
          />

          {summary && activeRun?.status === 'completed' ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Net PnL"
                  value={`$${summary.netPnl.toFixed(2)}`}
                  tone={summary.netPnl >= 0 ? 'good' : 'bad'}
                />
                <StatCard
                  label="Win rate"
                  value={`${(summary.winRate * 100).toFixed(1)}%`}
                />
                <StatCard
                  label="Max drawdown"
                  value={`${summary.maxDrawdownPct.toFixed(1)}%`}
                  tone="bad"
                />
                <StatCard
                  label="Signals"
                  value={String(summary.totalSignals)}
                  sub={noDataCount > 0 ? `${noDataCount} no market data` : undefined}
                />
              </div>

              <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200 mb-3">Equity curve</p>
                <BacktestEquityChart equity={equity} />
              </div>

              <BacktestSignalBreakdown trades={trades} channelNames={channelNames} />
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-12 text-center text-sm text-neutral-400">
              {isActive
                ? 'Backtest in progress…'
                : 'Configure channels and dates, then run a backtest to see results.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
