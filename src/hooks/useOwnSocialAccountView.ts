import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { resolveSocialAccountMode, socialBrokerDisplayLabel } from '../lib/socialAccount'
import { supabase } from '../lib/supabase'
import { hydrateTrader } from './useSocialTradingPreview'
import type { SocialProviderPerformance, SocialTradeHistoryItem } from '../lib/socialTradeHistory'
import type { SocialTrader } from '../lib/socialTradingFixture'

type OwnTradeRow = {
  id: string
  symbol: string
  direction: 'buy' | 'sell'
  status: string
  opened_at: string
  closed_at: string | null
  profit: number | string | null
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
    void supabase.from('trades')
      .select('id,symbol,direction,status,opened_at,closed_at,profit')
      .eq('user_id', user.id)
      .eq('broker_account_id', accountId)
      .order('opened_at', { ascending: false })
      .limit(2000)
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          setSnapshot({ accountId, trader: null, error: error.message })
          return
        }
        const history: SocialTradeHistoryItem[] = ((data ?? []) as OwnTradeRow[]).map(row => ({
          tradeId: row.id,
          symbol: row.symbol,
          direction: row.direction,
          status: row.status === 'closed' || row.closed_at ? 'closed' : 'open',
          openedAt: row.opened_at,
          closedAt: row.closed_at,
          realizedProfit: row.profit == null ? null : Number(row.profit),
        }))
        const closed = history.filter(item => item.status === 'closed' && item.realizedProfit != null)
        const positive = closed.filter(item => item.realizedProfit! > 0)
        const grossProfit = positive.reduce((sum, item) => sum + item.realizedProfit!, 0)
        const grossLoss = Math.abs(closed.filter(item => item.realizedProfit! < 0).reduce((sum, item) => sum + item.realizedProfit!, 0))
        const performance: SocialProviderPerformance = {
          sourceId: accountId,
          sourceLabel: account.label,
          sourceStatus: 'published',
          performanceStatus: history.length ? 'available' : 'no_history',
          statusReason: history.length ? 'current' : 'no_history',
          accountMode: resolveSocialAccountMode(account),
          currency: account.last_currency ?? null,
          periodStartedAt: closed.at(-1)?.openedAt ?? null,
          periodEndedAt: closed[0]?.closedAt ?? null,
          lastSyncSucceededAt: account.last_synced_at ?? null,
          calculatedAt: new Date().toISOString(),
          historyComplete: true,
          openTradeCount: history.filter(item => item.status === 'open').length,
          closedTradeCount: closed.length,
          realizedProfit: closed.reduce((sum, item) => sum + item.realizedProfit!, 0),
          winRate: closed.length ? (positive.length / closed.length) * 100 : null,
          profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
          returnPercentage: null,
          maximumDrawdown: null,
          equityCurveAvailable: false,
          isCopyEligible: false,
          eligibilityReason: 'owner_view',
          isSynthetic: false,
        }
        const hydrated = hydrateTrader(base, history, performance, null, null, base.sources ?? [])
        setSnapshot({
          accountId,
          trader: {
            ...hydrated,
            previewBalance: account.last_balance ?? null,
            sourceLabel: socialBrokerDisplayLabel(account),
            sourceProvider: account.provider ?? null,
            sourcePlatform: account.platform,
            sourceAccountMode: resolveSocialAccountMode(account),
          },
          error: null,
        })
      })
    return () => { active = false }
  }, [account, accountId, base, user?.id])

  const loading = Boolean(base?.isYou && accountId && snapshot.accountId !== accountId)
  return {
    trader: base?.isYou && accountId
      ? snapshot.accountId === accountId && snapshot.trader ? snapshot.trader : emptyAccountTrader(base)
      : base,
    loading,
    error: snapshot.accountId === accountId ? snapshot.error : null,
    account,
  }
}
