import type { SupabaseClient } from '@supabase/supabase-js'

type ConnectionStatus = 'pending' | 'connected' | 'error'

const MIN_WRITE_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.BROKER_CONNECTION_STATUS_MIN_WRITE_MS ?? 60_000),
)

const lastWritten = new Map<string, { status: ConnectionStatus; at: number }>()

/**
 * Debounced broker connection_status writer — worker is the sole DB writer.
 * Skips no-op updates and enforces a minimum interval per broker id.
 */
export async function writeBrokerConnectionStatus(
  supabase: SupabaseClient,
  brokerId: string,
  status: ConnectionStatus,
): Promise<void> {
  const now = Date.now()
  const prev = lastWritten.get(brokerId)
  if (prev?.status === status && now - prev.at < MIN_WRITE_INTERVAL_MS) return

  const { error } = await supabase
    .from('broker_accounts')
    .update({ connection_status: status })
    .eq('id', brokerId)
  if (error) {
    console.warn(`[brokerConnectionStatus] update failed broker=${brokerId}:`, error.message)
    return
  }
  lastWritten.set(brokerId, { status, at: now })
}

export function clearBrokerConnectionStatusCache(brokerId?: string): void {
  if (brokerId) lastWritten.delete(brokerId)
  else lastWritten.clear()
}
