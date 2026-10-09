/**
 * Best-effort write to `trade_execution_logs`.
 *
 * Two things make this helper necessary:
 *
 * 1. The Supabase client only sends a request once the query is awaited or
 *    `.then()` is called. `void query.insert(...)` builds the query and then
 *    drops it, so the row is never written and nothing fails.
 * 2. PostgREST errors are reported in the resolved `error` field, not by
 *    rejecting the promise (unless `.throwOnError()` is used). A plain
 *    `try { await insert } catch {}` therefore never sees a database-level
 *    rejection and swallows it silently.
 *
 * New audit writes should go through here so a dropped row leaves a trace.
 * The few sites that deliberately act on the resolved `{ error }` keep their
 * own direct insert and error handling.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { incMetric } from '../workerMetrics'
export type ExecutionLogRow = {
  user_id?: string | null
  signal_id?: string | null
  broker_account_id?: string | null
  action: string
  status: string
  request_payload?: Record<string, unknown> | null
  response_payload?: Record<string, unknown> | null
  error_message?: string | null
}
function describe(row: ExecutionLogRow): string {
  const parts = [`action=${row.action}`, `status=${row.status}`]
  if (row.signal_id) parts.push(`signal=${row.signal_id}`)
  return parts.join(' ')
}
/** Inserts one audit row and reports any failure instead of dropping it. */
export async function writeExecutionLog(
  supabase: SupabaseClient,
  row: ExecutionLogRow,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('trade_execution_logs')
      .insert(row as unknown as Record<string, unknown>)
    if (error) {
      incMetric('execution_log_write_failed')
      console.warn(
        `[executionLog] insert rejected ${describe(row)} code=${error.code} message=${error.message}`,
      )
    }
  } catch (err) {
    incMetric('execution_log_write_failed')
    console.warn(
      `[executionLog] insert threw ${describe(row)}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
