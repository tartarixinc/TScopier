import type { SupabaseClient } from '@supabase/supabase-js'

export type ListenerLeaseStatus = 'live' | 'expired' | 'missing' | 'unknown'

export type ListenerLeaseSnapshot = {
  status: ListenerLeaseStatus
  expiresAt: string | null
}

function isListenerLeaseRole(role: string | null | undefined): boolean {
  const r = String(role ?? '')
  return r === 'listener' || r === 'all'
}

export function listenerLeaseStatusFromRow(
  row: { expires_at: string; role?: string | null } | null | undefined,
  nowMs = Date.now(),
): ListenerLeaseSnapshot {
  if (!row || !isListenerLeaseRole(row.role)) {
    return { status: 'missing', expiresAt: null }
  }
  const expiresAt = row.expires_at
  if (new Date(expiresAt).getTime() > nowMs) {
    return { status: 'live', expiresAt }
  }
  return { status: 'expired', expiresAt }
}

export async function fetchListenerLeaseStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<ListenerLeaseSnapshot> {
  const { data, error } = await supabase
    .from('worker_session_leases')
    .select('expires_at, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.warn('[listenerLeaseStatus] fetch failed:', error.message)
    return { status: 'unknown', expiresAt: null }
  }

  return listenerLeaseStatusFromRow(data)
}
