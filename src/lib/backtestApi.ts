import { supabase } from './supabase'
import type {
  BacktestEquityRow,
  BacktestRunMode,
  BacktestRunRow,
  BacktestTradeRow,
  SimpleBacktestConfig,
} from './backtestTypes'

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
    trades: (trades ?? []) as BacktestTradeRow[],
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

export const backtestApi = {
  sync(config: SimpleBacktestConfig): Promise<BacktestSyncResult> {
    return call({ action: 'sync', config })
  },

  backtestTpsl(config: SimpleBacktestConfig): Promise<{ run_id: string; run_mode: BacktestRunMode }> {
    return call({ action: 'backtest_tpsl', config })
  },

  getRun(runId: string): Promise<{
    run: BacktestRunRow
    trades: BacktestTradeRow[]
    equity: BacktestEquityRow[]
  }> {
    return call({ action: 'get', run_id: runId })
  },
}
