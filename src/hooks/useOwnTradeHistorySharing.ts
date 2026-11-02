import { useEffect, useState } from 'react'
import { fetchSocialTradeHistoryAccess } from '../lib/socialTradeHistory'
import { supabase } from '../lib/supabase'

/** Whether the signed-in provider has Share trade history on (null while unknown). */
export function useOwnTradeHistorySharing(userId: string | null): boolean | null {
  const [state, setState] = useState<{ userId: string; sharing: boolean } | null>(null)
  useEffect(() => {
    if (!userId) return undefined
    let active = true
    fetchSocialTradeHistoryAccess(supabase, userId)
      .then(access => { if (active) setState({ userId, sharing: access.sharingEnabled }) })
      .catch(() => { if (active) setState(null) })
    return () => { active = false }
  }, [userId])
  return userId && state?.userId === userId ? state.sharing : null
}
