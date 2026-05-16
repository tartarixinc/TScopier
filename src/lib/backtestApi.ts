import { supabase } from './supabase'
import type {
  BacktestEquityRow,
  BacktestRunConfig,
  BacktestRunRow,
  BacktestTradeRow,
} from './backtestTypes'

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

export interface BacktestPreviewResult {
  tradeable_count: number
  stored_count: number
  massive_configured: boolean
  signal_source?: string
  copier_isolated?: boolean
}

export const backtestApi = {
  listRuns(): Promise<{ runs: BacktestRunRow[] }> {
    return call({ action: 'list' })
  },

  preview(config: BacktestRunConfig): Promise<BacktestPreviewResult> {
    return call({ action: 'preview', config })
  },

  createRun(name: string, config: BacktestRunConfig): Promise<{ run_id: string }> {
    return call({ action: 'create', name, config })
  },

  getRun(runId: string): Promise<{
    run: BacktestRunRow
    trades: BacktestTradeRow[]
    equity: BacktestEquityRow[]
  }> {
    return call({ action: 'get', run_id: runId })
  },
}
