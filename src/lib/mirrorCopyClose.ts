import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * User-initiated close of one mirror copy.
 *
 * The UI never talks to a broker: it records intent (`state='closing'` on the
 * mapping) through the owner-scoped `request_mirror_copy_close` RPC, and the
 * worker executes the close on its next reconcile tick (~20s) through the same
 * closeMapping path it uses when a master trade closes — event claim, re-read
 * before send, uncertain retry. This module only does the request and the wait.
 */

/** Mapping states the RPC accepts (mirrors the SQL guard). */
const CLOSABLE_STATES = new Set(['open', 'uncertain', 'error', 'closing'])

/** Whether a mapping in this ledger state can be asked to close. */
export function canRequestMirrorClose(state: string | null | undefined): boolean {
  return !!state && CLOSABLE_STATES.has(state)
}

export interface MirrorCloseRequestResult {
  /** True when the request was recorded; false when nothing changed (already closed). */
  applied: boolean
  error: string | null
}

/** Record the close request. Never throws; errors come back as `error`. */
export async function requestMirrorCopyClose(
  supabase: SupabaseClient,
  mappingId: string,
): Promise<MirrorCloseRequestResult> {
  if (!mappingId) return { applied: false, error: 'mapping_missing' }
  const { data, error } = await supabase.rpc('request_mirror_copy_close', {
    p_mapping_id: mappingId,
  })
  if (error) return { applied: false, error: error.message }
  return { applied: data === true, error: null }
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type MirrorCloseWaitOutcome = 'closed' | 'timeout' | 'read-error'

export interface MirrorCloseWaitResult {
  outcome: MirrorCloseWaitOutcome
  /** Last read error when outcome is 'read-error' (kept for the user-facing message). */
  error: string | null
}

export interface MirrorCloseWaitOptions {
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Poll the mapping until the worker confirms the close. A read error does not
 * abort the wait (a transient outage must not fail a request that is already
 * recorded) — it only matters if the timeout is reached without ever seeing
 * 'closed'. Once closed, never reports anything else.
 */
export async function waitForMirrorCopyClosed(
  supabase: SupabaseClient,
  mappingId: string,
  options: MirrorCloseWaitOptions = {},
): Promise<MirrorCloseWaitResult> {
  const {
    timeoutMs = 45_000,
    pollMs = 2_000,
    now = Date.now,
    sleep = realSleep,
  } = options
  const deadline = now() + timeoutMs
  let lastError: string | null

  for (;;) {
    const { data, error } = await supabase
      .from('mirror_copy_trade_mappings')
      .select('state')
      .eq('id', mappingId)
      .maybeSingle()
    if (error) {
      lastError = error.message
    } else {
      const state = String((data as { state?: unknown } | null)?.state ?? '')
      if (state === 'closed') return { outcome: 'closed', error: null }
      lastError = null
    }
    if (now() >= deadline) {
      return lastError
        ? { outcome: 'read-error', error: lastError }
        : { outcome: 'timeout', error: null }
    }
    await sleep(pollMs)
  }
}
