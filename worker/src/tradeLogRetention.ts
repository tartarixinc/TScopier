import type { SupabaseClient } from '@supabase/supabase-js'

const RETENTION_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.TRADE_LOG_RETENTION_INTERVAL_MS ?? 10 * 60_000),
)
/** Match Management page fetch cap (`TRADE_ACTIVITY_FETCH_LIMIT`). */
const RETENTION_KEEP = Math.max(1, Number(process.env.TRADE_LOG_RETENTION_KEEP ?? 500))

export function startTradeLogRetention(supabase: SupabaseClient): () => void {
  const tick = async () => {
    try {
      const { data, error } = await supabase.rpc('prune_all_trade_execution_logs', {
        p_keep: RETENTION_KEEP,
      })
      if (error) {
        console.warn('[tradeLogRetention] prune failed:', error.message)
        return
      }
      const n = Number(data ?? 0)
      if (n > 0) {
        console.log(`[tradeLogRetention] pruned ${n} old log rows (keep=${RETENTION_KEEP}/user)`)
      }
    } catch (err) {
      console.warn('[tradeLogRetention] error:', err instanceof Error ? err.message : String(err))
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, RETENTION_INTERVAL_MS)
  timer.unref?.()
  console.log(`[tradeLogRetention] scheduled every ${RETENTION_INTERVAL_MS}ms keep=${RETENTION_KEEP}`)

  return () => clearInterval(timer)
}
