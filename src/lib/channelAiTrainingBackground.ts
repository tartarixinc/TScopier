import { supabase } from './supabase'
import { saveChannelTraining, trainChannelSignals } from './analyzeChannelProfile'

export const CHANNEL_AI_TRAINING_LOOKBACK_DAYS = 30

export type ChannelAiTrainingProgressHandlers = {
  onRunningChange?: (running: boolean) => void
  onSavingChange?: (saving: boolean) => void
  onProgressChange?: (progress: number) => void
}

export async function channelHasAiTraining(userId: string, channelId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('channel_signal_profiles')
    .select('meta')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const meta = data?.meta && typeof data.meta === 'object'
    ? data.meta as Record<string, unknown>
    : {}
  const raw = meta.ai_training_schema
  return Boolean(raw && typeof raw === 'object')
}

async function backfillChannelSignalsForTraining(
  channelId: string,
  lookbackDays: number,
): Promise<{ imported: number; messages: string[] }> {
  const token = (await supabase.auth.getSession()).data.session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/telegram-auth`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'backfill_channel_history',
      channel_row_id: channelId,
      days: lookbackDays,
      for_training: true,
    }),
  })
  const data = await res.json().catch(() => ({})) as {
    error?: unknown
    message?: unknown
    imported?: number
    messages?: string[]
  }
  if (!res.ok || data.error) {
    const msg =
      typeof data.error === 'string'
        ? data.error
        : typeof data.message === 'string'
          ? data.message
          : 'Failed to import Telegram channel history'
    throw new Error(msg)
  }
  return {
    imported: Number(data.imported ?? 0),
    messages: Array.isArray(data.messages) ? data.messages.filter((m): m is string => typeof m === 'string') : [],
  }
}

/** Train and auto-save channel signal schema in the background (after link/connect). */
export async function triggerBackgroundChannelAiTraining(
  channelId: string,
  opts?: {
    userId?: string
    lookbackDays?: number
    skipIfAlreadyTrained?: boolean
    historicalMessages?: string[]
    progress?: ChannelAiTrainingProgressHandlers
  },
): Promise<{ trained: boolean; error?: string }> {
  const lookbackDays = opts?.lookbackDays ?? CHANNEL_AI_TRAINING_LOOKBACK_DAYS
  const progress = opts?.progress

  try {
    if (opts?.skipIfAlreadyTrained !== false && opts?.userId) {
      const exists = await channelHasAiTraining(opts.userId, channelId)
      if (exists) return { trained: false }
    }

    progress?.onRunningChange?.(true)
    progress?.onProgressChange?.(5)

    let historicalMessages = opts?.historicalMessages
    if (!historicalMessages) {
      try {
        const backfill = await backfillChannelSignalsForTraining(channelId, lookbackDays)
        historicalMessages = backfill.messages
      } catch (err) {
        console.warn('[channel-ai-training] backfill failed:', err)
      }
    }

    const result = await trainChannelSignals(
      channelId,
      lookbackDays,
      historicalMessages,
    )
    if (!result.ok || !result.training_schema) {
      throw new Error(result.error || 'AI training failed')
    }

    progress?.onProgressChange?.(94)
    progress?.onRunningChange?.(false)
    progress?.onSavingChange?.(true)

    const saved = await saveChannelTraining(channelId, result.training_schema)
    if (!saved.ok) throw new Error(saved.error || 'Failed to save AI training')

    progress?.onProgressChange?.(100)
    return { trained: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI training failed'
    console.warn('[channel-ai-training]', message)
    return { trained: false, error: message }
  } finally {
    progress?.onRunningChange?.(false)
    progress?.onSavingChange?.(false)
    window.setTimeout(() => progress?.onProgressChange?.(0), 400)
  }
}
