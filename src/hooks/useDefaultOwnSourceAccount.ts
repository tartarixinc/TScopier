import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { supabase } from '../lib/supabase'

/**
 * The account the "You" profile should show by default: the provider's published source
 * account, or the only connected account. Returns '' until it is known (or when ambiguous).
 */
export function useDefaultOwnSourceAccount(enabled: boolean): string {
  const { user } = useAuth()
  const { brokers } = useBrokerAccounts()
  const [published, setPublished] = useState<{ userId: string; accountId: string | null } | null>(null)

  useEffect(() => {
    if (!enabled || !user?.id) return undefined
    const userId = user.id
    let active = true
    void Promise.resolve(
      supabase
        .from('social_copy_sources')
        .select('broker_account_id')
        .eq('trader_user_id', userId)
        .eq('status', 'published')
        .order('created_at', { ascending: true })
        .limit(1),
    ).then(({ data }) => {
      if (active) setPublished({ userId, accountId: (data?.[0]?.broker_account_id as string | undefined) ?? null })
    }, () => {
      if (active) setPublished({ userId, accountId: null })
    })
    return () => { active = false }
  }, [enabled, user?.id])

  if (!enabled || !user?.id) return ''
  const publishedId = published?.userId === user.id ? published.accountId : null
  if (publishedId && brokers.some(account => account.id === publishedId)) return publishedId
  return brokers.length === 1 ? brokers[0].id : ''
}
