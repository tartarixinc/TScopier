/** One reconnect attempt per broker at a time; minimum gap between automatic edge calls. */

const inFlight = new Set<string>()
const lastAttemptAt = new Map<string, number>()

export const BROKER_RECONNECT_MIN_GAP_MS = Math.max(
  3_000,
  Number(import.meta.env.VITE_BROKER_RECONNECT_MIN_GAP_MS ?? 8_000) || 8_000,
)

export function brokerReconnectInFlight(brokerId: string): boolean {
  return inFlight.has(brokerId)
}

export function brokerReconnectBlockedReason(
  brokerId: string,
  opts?: { bypassGap?: boolean },
): 'in_flight' | 'gap' | null {
  if (inFlight.has(brokerId)) return 'in_flight'
  if (opts?.bypassGap) return null
  const last = lastAttemptAt.get(brokerId) ?? 0
  if (Date.now() - last < BROKER_RECONNECT_MIN_GAP_MS) return 'gap'
  return null
}

export function tryBeginBrokerReconnect(
  brokerId: string,
  opts?: { bypassGap?: boolean },
): boolean {
  if (brokerReconnectBlockedReason(brokerId, opts)) return false
  inFlight.add(brokerId)
  lastAttemptAt.set(brokerId, Date.now())
  return true
}

export function endBrokerReconnect(brokerId: string): void {
  inFlight.delete(brokerId)
}
