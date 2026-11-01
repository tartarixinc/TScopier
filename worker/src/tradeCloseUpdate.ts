import type { TradeCloseReason } from './tradeCloseReasons'

/** Terminal trades patch. `close_reason` is typed so a typo'd code fails tsc. */
export type ClosePatch = Record<string, unknown> & { close_reason?: TradeCloseReason }

interface CloseUpdateResponse {
  error: { code?: string; message?: string | null } | null
}

export interface CloseColumnUpdateOptions {
  /** Table label used in the retry warning, e.g. 'trades'. */
  table: string
  /** Migration a deployer should apply to restore the reason. */
  migration: string
}

/**
 * Apply a terminal close update that carries `close_reason`, tolerating a
 * database that predates the column.
 *
 * The migrations that add these columns are applied by hand (the Management
 * API is read-only), so a worker can start while the column is still missing.
 * PostgREST then rejects the WHOLE update with PGRST204 and executes no SQL,
 * which would leave a closed position sitting as `open` forever. Retry the same
 * update without the reason so the close always lands.
 */
export async function applyCloseColumnUpdate<
  P extends Record<string, unknown> & { close_reason?: string },
  R extends CloseUpdateResponse,
>(
  patch: P,
  run: (patch: P) => PromiseLike<R>,
  options: CloseColumnUpdateOptions,
): Promise<R> {
  const first = await run(patch)
  const error = first.error
  const message = error?.message ?? ''
  // PGRST204 is PostgREST's dedicated "column not in the schema cache" error;
  // our patches only ever add close_reason as a new column, so any PGRST204 on
  // them is that column. Postgres 42703 (undefined column) can also be about a
  // different column, so it must name close_reason before we strip it and
  // retry — otherwise a half-migrated schema could silently lose the reason.
  const missingColumn =
    !!error &&
    ('close_reason' in patch) &&
    (error.code === 'PGRST204' || (error.code === '42703' && /close_reason/.test(message)))
  if (!missingColumn) return first

  console.warn(
    `[${options.table}] close_reason column missing — retrying close without it`
    + ` (apply ${options.migration})`,
  )
  const rest = { ...patch }
  delete rest.close_reason
  return run(rest as P)
}

/** `trades.close_reason` convenience wrapper (keeps the typed reason list). */
export function applyCloseUpdate<R extends CloseUpdateResponse>(
  patch: ClosePatch,
  run: (patch: ClosePatch) => PromiseLike<R>,
): Promise<R> {
  return applyCloseColumnUpdate(patch, run, {
    table: 'trades',
    migration: 'supabase/migrations/20261006130000_trades_close_reason.sql',
  })
}
