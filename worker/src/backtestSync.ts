/**
 * Backtest Telegram history sync on a dedicated short-lived MTProto connection.
 * Never shares the live UserListener client (avoids AUTH_KEY_DUPLICATED).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildClient } from './telegramClient'
import { UserListener, telegramConnectTimeoutMs, withTelegramTimeout } from './userListener'

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
    // destroy(), not disconnect(): constructing the UserListener above attached
    // the update-loop TIMEOUT recovery handler to this client, and that handler
    // reconnects unconditionally (incident 2026-09-29). A client that is only
    // disconnected keeps its gramjs update loop alive, so ~10 s after this
    // function returns the client would reconnect on its own and hold a second
    // MTProto session on the same auth key (AUTH_KEY_DUPLICATED). destroy()
    // sets the loop's exit flag synchronously; both steps are bounded so a hung
    // socket cannot stall the backtest job.
    try {
      await withTelegramTimeout(
        client.destroy(),
        telegramConnectTimeoutMs(),
        `ephemeral listener destroy ${userId}`,
      )
    } catch {
      try {
        await withTelegramTimeout(
          client.disconnect(),
          5_000,
          `ephemeral listener disconnect ${userId}`,
        )
      } catch {
        /* ignore */
      }
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
