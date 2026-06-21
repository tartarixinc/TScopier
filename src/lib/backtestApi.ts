import { supabase } from './supabase'
import type {
  BacktestEquityRow,
  BacktestRunMode,
  BacktestRunRow,
  BacktestTradeReplayResponse,
  BacktestTradeRow,
  SimpleBacktestConfig,
} from './backtestTypes'

export function normalizeBacktestTradeRow(row: Record<string, unknown>): BacktestTradeRow {
  const details = (row.details ?? {}) as BacktestTradeRow['details']
  const tpRaw = row.tp_levels
  const tp_levels = Array.isArray(tpRaw)
    ? tpRaw.map(v => Number(v)).filter(n => Number.isFinite(n))
    : []

  return {
    id: String(row.id),
    symbol: String(row.symbol),
    direction: String(row.direction),
    signal_at: String(row.signal_at),
    outcome: String(row.outcome),
    tps_hit: Number(row.tps_hit ?? 0),
    pnl: Number(row.pnl ?? 0),
    pnl_r: row.pnl_r != null ? Number(row.pnl_r) : null,
    entry_price: Number(row.entry_price),
    exit_price: row.exit_price != null ? Number(row.exit_price) : null,
    closed_at: row.closed_at != null ? String(row.closed_at) : null,
    sl: row.sl != null ? Number(row.sl) : null,
    tp_levels,
    lot_size: Number(row.lot_size) > 0 ? Number(row.lot_size) : 0.01,
    channel_id: row.channel_id != null ? String(row.channel_id) : null,
    details,
  }
}

/** Load run + trades via RLS (reliable while edge run is in progress or after completion). */
export async function loadBacktestRunFromDb(
  runId: string,
  userId: string,
): Promise<{
  run: BacktestRunRow
  trades: BacktestTradeRow[]
  equity: BacktestEquityRow[]
}> {
  const { data: run, error: runErr } = await supabase
    .from('backtest_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!run) throw new Error('Run not found')

  const [{ data: trades, error: tradesErr }, { data: equity, error: eqErr }] = await Promise.all([
    supabase.from('backtest_trades').select('*').eq('run_id', runId).order('signal_at'),
    supabase.from('backtest_equity_points').select('*').eq('run_id', runId).order('ts'),
  ])
  if (tradesErr) throw new Error(tradesErr.message)
  if (eqErr) throw new Error(eqErr.message)

  return {
    run: run as BacktestRunRow,
    trades: (trades ?? []).map(r => normalizeBacktestTradeRow(r as Record<string, unknown>)),
    equity: (equity ?? []) as BacktestEquityRow[],
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/backtest-run`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(
      'Could not reach backtest-run. Deploy the edge function and apply the backtest migration (see docs/backtest-setup.md).',
    )
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error)
      : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export interface BacktestSyncResult {
  messages_scanned: number
  candidates: number
  imported: number
  errors: string[]
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** Poll DB until the edge worker finishes (backtest-run returns before simulation ends). */
export async function waitForBacktestRunComplete(
  runId: string,
  userId: string,
  options?: {
    intervalMs?: number
    timeoutMs?: number
    onTick?: (payload: { run: BacktestRunRow; trades: BacktestTradeRow[] }) => void
  },
): Promise<{ run: BacktestRunRow; trades: BacktestTradeRow[] }> {
  const intervalMs = options?.intervalMs ?? 1500
  const timeoutMs = options?.timeoutMs ?? 600_000
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const payload = await loadBacktestRunFromDb(runId, userId)
    options?.onTick?.({ run: payload.run, trades: payload.trades })
    if (isTerminalRunStatus(payload.run.status)) {
      return { run: payload.run, trades: payload.trades }
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }

  throw new Error('Backtest is taking longer than expected. Open History to view the run when it completes.')
}

function parseSyncSummary(raw: unknown): BacktestSyncResult {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    messages_scanned: Number(o.messages_scanned ?? 0),
    candidates: Number(o.candidates ?? 0),
    imported: Number(o.imported ?? 0),
    errors: Array.isArray(o.errors) ? o.errors.map(String).filter(Boolean) : [],
  }
}

function resolveSyncRunId(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null
  const syncRunId = data.sync_run_id ?? data.run_id
  return typeof syncRunId === 'string' && syncRunId.trim() ? syncRunId.trim() : null
}

function isLegacySyncResponse(data: Record<string, unknown>): boolean {
  return (
    data.ok === true
    || typeof data.messages_scanned === 'number'
    || typeof data.imported === 'number'
    || typeof data.candidates === 'number'
    || Array.isArray(data.errors)
  )
}

/** Poll DB until signal sync finishes (sync action returns before worker completes). */
export async function waitForSignalSyncComplete(
  syncRunId: string,
  userId: string,
  options?: {
    intervalMs?: number
    timeoutMs?: number
    onTick?: (run: BacktestRunRow) => void
  },
): Promise<BacktestSyncResult> {
  const intervalMs = options?.intervalMs ?? 800
  const timeoutMs = options?.timeoutMs ?? 600_000
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const { run } = await loadBacktestRunFromDb(syncRunId, userId)
    options?.onTick?.(run)
    if (run.status === 'completed') {
      return parseSyncSummary(run.summary)
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(run.error_message ?? run.progress_message ?? 'Signal sync failed')
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }

  throw new Error('Signal sync is taking longer than expected. Try again in a moment.')
}

const tradeReplayCache = new Map<string, BacktestTradeReplayResponse>()

export const backtestApi = {
  async sync(config: SimpleBacktestConfig): Promise<
    | { mode: 'async'; sync_run_id: string }
    | { mode: 'legacy'; result: BacktestSyncResult }
  > {
    const data = await call<Record<string, unknown>>({ action: 'sync', config })
    const syncRunId = resolveSyncRunId(data)
    if (syncRunId) {
      return { mode: 'async', sync_run_id: syncRunId }
    }
    if (data && isLegacySyncResponse(data)) {
      return { mode: 'legacy', result: parseSyncSummary(data) }
    }
    throw new Error(
      'Signal sync started but no sync run id was returned. Redeploy the backtest-run edge function (see docs/backtest-setup.md).',
    )
  },

  async syncAndWait(
    config: SimpleBacktestConfig,
    userId: string,
    options?: {
      intervalMs?: number
      timeoutMs?: number
      onTick?: (run: BacktestRunRow) => void
    },
  ): Promise<BacktestSyncResult> {
    const started = await backtestApi.sync(config)
    if (started.mode === 'legacy') return started.result
    return waitForSignalSyncComplete(started.sync_run_id, userId, options)
  },

  waitForSignalSyncComplete,

  async backtestTpsl(config: SimpleBacktestConfig): Promise<{ run_id: string; run_mode: BacktestRunMode }> {
    const data = await call<{ ok?: boolean; run_id?: string; run_mode?: BacktestRunMode }>({
      action: 'backtest_tpsl',
      config,
    })
    const runId = data?.run_id
    if (!runId) throw new Error('Backtest started but no run id was returned from the server.')
    return { run_id: runId, run_mode: data.run_mode ?? 'tpsl' }
  },

  getRun(runId: string): Promise<{
    run: BacktestRunRow
    trades: BacktestTradeRow[]
    equity: BacktestEquityRow[]
  }> {
    return call({ action: 'get', run_id: runId })
  },

  async resimulateTrade(payload: {
    trade_id: string
    direction: 'buy' | 'sell'
    entry_price: number
    sl: number | null
    tp_levels: number[]
  }): Promise<{ trade: BacktestTradeRow; run: BacktestRunRow | null }> {
    const data = await call<{ trade: Record<string, unknown>; run: BacktestRunRow | null }>({
      action: 'resimulate_trade',
      ...payload,
    })
    return {
      trade: normalizeBacktestTradeRow(data.trade),
      run: data.run ?? null,
    }
  },

  async deleteTrade(tradeId: string): Promise<{ run_id: string; run: BacktestRunRow | null }> {
    const data = await call<{ run_id: string; run: BacktestRunRow | null }>({
      action: 'delete_trade',
      trade_id: tradeId,
    })
    return { run_id: data.run_id, run: data.run ?? null }
  },

  async getTradeReplay(tradeId: string): Promise<BacktestTradeReplayResponse> {
    const cached = tradeReplayCache.get(tradeId)
    if (cached) return cached
    const data = await call<BacktestTradeReplayResponse>({
      action: 'trade_replay',
      trade_id: tradeId,
    })
    tradeReplayCache.set(tradeId, data)
    return data
  },

  clearTradeReplayCache(tradeId?: string) {
    if (tradeId) tradeReplayCache.delete(tradeId)
    else tradeReplayCache.clear()
  },
}
