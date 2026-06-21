import { supabase } from './supabase'

let cachedUserId: string | null | undefined
let cachedPromise: Promise<void> | null = null

/**
 * Wait until the Supabase session JWT is applied to the Realtime socket.
 * Subscribing before this completes often triggers a failed WebSocket connect
 * followed by an immediate reconnect once auth is set.
 */
export function whenRealtimeReady(userId?: string | null): Promise<void> {
  const key = userId ?? null
  if (cachedPromise && cachedUserId === key) return cachedPromise

  cachedUserId = key
  cachedPromise = supabase.auth.getSession().then(async ({ data: { session } }) => {
    if (session?.access_token) {
      await supabase.realtime.setAuth(session.access_token)
    }
  })

  return cachedPromise
}

export function invalidateRealtimeReadyCache(): void {
  cachedUserId = undefined
  cachedPromise = null
}
