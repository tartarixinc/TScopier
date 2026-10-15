import type { TradeCloseReason } from './tradeCloseReasons'

/** Terminal trades patch. `close_reason` is typed so a typo'd code fails tsc. */
export type ClosePatch = Record<string, unknown> & { close_reason?: TradeCloseReason }

interface CloseUpdateResponse {
  error: { code?: string; message?: string | null } | null
}

/**
 * Apply a terminal `trades` update that carries `close_reason`.
 *
 * The migration that adds the column is applied by hand (the Management API is
 * read-only), so a worker can start while the column is still missing there.
 * PostgREST then rejects the WHOLE update with PGRST204 and executes no SQL,
 * which would leave a broker-closed trade sitting as `open` forever. Retry the
 * same update without the reason so the close always lands.
 */
export async function applyCloseUpdate<R extends CloseUpdateResponse>(
  patch: ClosePatch,
  run: (patch: ClosePatch) => PromiseLike<R>,
): Promise<R> {
  const first = await run(patch)
  const error = first.error
  const missingColumn =
    !!error &&
    ('close_reason' in patch) &&
    (error.code === 'PGRST204' || /close_reason/.test(error.message ?? ''))
  if (!missingColumn) return first

  console.warn(
    '[trades] trades.close_reason column missing — retrying close without it'
    + ' (apply supabase/migrations/20261006130000_trades_close_reason.sql)',
  )
  const rest = { ...patch }
  delete rest.close_reason
  return run(rest)
}
