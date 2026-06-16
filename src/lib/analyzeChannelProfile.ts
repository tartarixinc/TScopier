import { supabase } from './supabase'
import {
  detectChannelSymbols,
  mergeSymbolCountsFromProfile,
  type ChannelSignalRow,
  type DetectedChannelSymbol,
} from './channelSymbolDetection'

export type AnalyzeChannelProfileResult = {
  ok: boolean
  profile?: {
    meta?: Record<string, unknown>
    most_traded_asset?: string | null
    sample_size?: number
    analysis_summary?: string | null
  }
  detected_symbols?: string[]
  error?: string
}

export type ManagementKeywordGroups = {
  close_all: string[]
  close_partial: string[]
  close_half: string[]
  break_even: string[]
  modify_sl: string[]
  modify_tp: string[]
  close_worse_entries: string[]
}

export type SignalTrainingSchema = {
  entry_cues: string[]
  buy_cues: string[]
  sell_cues: string[]
  stop_loss_cues: string[]
  take_profit_cues: string[]
  take_profit_tier_cues: string[]
  management_cues: string[]
  management_keyword_groups?: ManagementKeywordGroups
  market_order_cues?: string[]
  signal_order_pattern: 'signal_then_price' | 'price_then_signal' | 'mixed' | 'unknown'
  signal_requires_price: boolean | null
  language_hints: string[]
  sample_signal_examples: string[]
  notes: string
}

export type TrainChannelSignalsResult = {
  ok: boolean
  training_schema?: SignalTrainingSchema
  profile?: {
    meta?: Record<string, unknown>
  }
  error?: string
}

async function callAnalyzeChannelProfile(body: Record<string, unknown>): Promise<AnalyzeChannelProfileResult> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/analyze-channel-profile`
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
      'Could not reach analyze-channel-profile. Deploy the edge function to refresh channel analysis.',
    )
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as AnalyzeChannelProfileResult
}

export async function analyzeChannelProfile(
  channelId: string,
  lookbackDays = 30,
): Promise<AnalyzeChannelProfileResult> {
  return callAnalyzeChannelProfile({ channel_id: channelId, lookback_days: lookbackDays })
}

export async function trainChannelSignals(
  channelId: string,
  lookbackDays = 30,
  historicalMessages?: string[],
): Promise<TrainChannelSignalsResult> {
  return callAnalyzeChannelProfile({
    channel_id: channelId,
    lookback_days: lookbackDays,
    action: 'train',
    ...(historicalMessages && historicalMessages.length > 0
      ? { historical_messages: historicalMessages.slice(0, 300) }
      : {}),
  }) as Promise<TrainChannelSignalsResult>
}

export async function saveChannelTraining(
  channelId: string,
  trainingSchema: SignalTrainingSchema,
): Promise<TrainChannelSignalsResult> {
  return callAnalyzeChannelProfile({
    channel_id: channelId,
    action: 'save_training',
    training_schema: trainingSchema,
  }) as Promise<TrainChannelSignalsResult>
}

export function detectedSymbolsFromProfileResponse(
  signalRows: ChannelSignalRow[],
  result: AnalyzeChannelProfileResult,
): DetectedChannelSymbol[] {
  let detected = detectChannelSymbols(signalRows)
  const meta = result.profile?.meta
  const symbolCounts =
    meta && typeof meta === 'object' && meta.symbol_counts && typeof meta.symbol_counts === 'object'
      ? (meta.symbol_counts as Record<string, number>)
      : null
  detected = mergeSymbolCountsFromProfile(detected, symbolCounts)
  if (Array.isArray(result.detected_symbols) && result.detected_symbols.length > 0) {
    const map = new Map(detected.map(d => [d.symbol, d.count]))
    for (const raw of result.detected_symbols) {
      const sym = String(raw).toUpperCase()
      if (sym) map.set(sym, map.get(sym) ?? 1)
    }
    detected = [...map.entries()]
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
  }
  return detected
}
