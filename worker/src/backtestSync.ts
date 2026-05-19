/**
 * Backtest Telegram history sync on a dedicated short-lived MTProto connection.
 * Never shares the live UserListener client (avoids AUTH_KEY_DUPLICATED).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildClient } from './telegramClient'
import { UserListener } from './userListener'

async function loadSessionString(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data: sess, error } = await supabase
    .from('telegram_sessions')
    .select('session_string')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!sess?.session_string) throw new Error('No active Telegram session')
  return sess.session_string
}

/** Short-lived MTProto client; never uses the live UserListener connection. */
export async function runWithEphemeralListener<T>(
  supabase: SupabaseClient,
  userId: string,
  fn: (listener: UserListener) => Promise<T>,
): Promise<T> {
  const sessionString = await loadSessionString(supabase, userId)
  const client = buildClient(sessionString)
  try {
    await client.connect()
    const listener = new UserListener(userId, sessionString, supabase, client)
    return await fn(listener)
  } finally {
    try {
      await client.disconnect()
    } catch {
      /* ignore */
    }
  }
}

export async function runEphemeralBacktestSync(
  supabase: SupabaseClient,
  userId: string,
  channelRowId: string,
  fromIso: string,
  toIso: string,
  runId?: string,
): Promise<{
  messages_scanned: number
  candidates: number
  imported: number
  errors: string[]
}> {
  return runWithEphemeralListener(supabase, userId, listener =>
    listener.syncBacktestSignals(channelRowId, fromIso, toIso, { runId }),
  )
}
