import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { resolveAccountDeposit } from '../lib/accountDeposit'
import { isVerifiedSocialBrokerTicket, normalizeSocialBrokerTicket, resolveSocialAccountMode, socialBrokerDisplayLabel } from '../lib/socialAccount'
import { formatAccountLeverage } from '../lib/providerApplication'
import { computeMaxDrawdownPct, computeReturnPct } from '../lib/maxDrawdown'
import { supabase } from '../lib/supabase'
import { hydrateTrader } from './useSocialTradingPreview'
import type { SocialProviderPerformance, SocialTradeHistoryItem } from '../lib/socialTradeHistory'
import type { SocialTrader } from '../lib/socialTradingFixture'

function finiteMoney(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

type OwnTradeRow = {
  id: string
  symbol: string
  direction: 'buy' | 'sell'
  status: string
  opened_at: string
  closed_at: string | null
  profit: number | string | null
  metaapi_order_id: string | null
}

type Snapshot = {
  accountId: string
  trader: SocialTrader | null
  error: string | null
}

function emptyAccountTrader(base: SocialTrader): SocialTrader {
  return {
    ...base,
    roi: null,
    winRate: null,
    maxDrawdown: null,
    closedTrades: null,
    openTradeCount: null,
    performanceStatus: 'loading',
    performanceError: null,
    historyAvailable: false,
    openTrades: [],
    closedPerformance: [],
    activities: [],
    chart: { series: [], growth: [], outcome: [] },
  }
}

export function useOwnSocialAccountView(base: SocialTrader | undefined, accountId: string) {
  const { user } = useAuth()
  const { brokers } = useBrokerAccounts()
  const account = useMemo(() => brokers.find(item => item.id === accountId) ?? null, [accountId, brokers])
  const [snapshot, setSnapshot] = useState<Snapshot>({ accountId: '', trader: null, error: null })

  useEffect(() => {
    if (!base?.isYou || !user?.id || !accountId || !account) return
    let active = true
    /** First paint only needs a bounded window (matches dashboard critical path). */
    const OWN_TRADES_FETCH_LIMIT = 800

    void (async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('id,symbol,direction,status,opened_at,closed_at,profit,metaapi_order_id')
        .eq('user_id', user.id)
        .eq('broker_account_id', accountId)
        .order('opened_at', { ascending: false })
        .limit(OWN_TRADES_FETCH_LIMIT)
      if (!active) return
      if (error) {
        setSnapshot({ accountId, trader: null, error: error.message })
        return
      }
      const rows = (data ?? []) as OwnTradeRow[]
      const truncated = rows.length >= OWN_TRADES_FETCH_LIMIT
      if (!active) return

      const seenTickets = new Set<string>()
      const uniqueRows = rows.filter(row => {
        const ticket = normalizeSocialBrokerTicket(account.provider, row.metaapi_order_id)
        if (!ticket) return true
        if (seenTickets.has(ticket)) return false
        seenTickets.add(ticket)
        return true
      })
    return () => { active = false }
  }, [account, accountId, base, user?.id])

  const loading = Boolean(base?.isYou && accountId && snapshot.accountId !== accountId)
  const trader = useMemo(() => {
    if (!base?.isYou || !accountId) return base
    const raw = snapshot.accountId === accountId && snapshot.trader
      ? snapshot.trader
      : emptyAccountTrader(base)
    if (!account) return raw
    // Keep deposit/equity in sync with the linked account row (including after live summary merges).
    const deposit = resolveAccountDeposit(account)
    const equity = finiteMoney(account.last_equity)
    const balance = finiteMoney(account.last_balance)
    const withdrawals = finiteMoney(account.total_withdrawals)
    if (
      deposit === (raw.accountDeposits ?? null)
      && equity === (raw.accountEquity ?? null)
      && balance === (raw.previewBalance ?? null)
      && withdrawals === (raw.accountWithdrawals ?? null)
    ) {
      return raw
    }
    return {
      ...raw,
      accountDeposits: deposit,
      accountEquity: equity ?? raw.accountEquity ?? null,
      previewBalance: balance ?? raw.previewBalance ?? null,
      accountWithdrawals: withdrawals,
      accountSnapshotAt: account.last_synced_at ?? raw.accountSnapshotAt ?? null,
    }
  }, [account, accountId, base, snapshot.accountId, snapshot.trader])

  return {
    trader,
    loading,
    error: snapshot.accountId === accountId ? snapshot.error : null,
    account,
  }
}
