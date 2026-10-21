import { useEffect, useMemo, useState } from 'react'
import { useSocialFollow } from './useSocialFollow'
import { fetchSocialCopySources } from '../lib/socialCopy'
import {
  fetchSocialProviderPerformance,
  fetchSocialTradeHistory,
  fetchSocialTradeHistoryAccess,
  type SocialTradeHistoryItem,
} from '../lib/socialTradeHistory'
import { supabase } from '../lib/supabase'
import type { SocialDirectoryProfile } from '../lib/socialFollow'
import type { SocialTrader } from '../lib/socialTradingFixture'

function previewTrader(profile: SocialDirectoryProfile, rank: number): SocialTrader {
  return {
    id: profile.profileUserId,
    displayName: profile.displayName,
    username: profile.username,
    isYou: profile.isSelf,
    access: profile.access,
    monthlyCopyPriceCents: profile.monthlyCopyPriceCents,
    allowFollowing: true,
    roi: null,
    winRate: null,
    maxDrawdown: null,
    closedTrades: 0,
    followerCount: profile.followerCount,
    rating: profile.averageRating,
    ratingCount: profile.reviewCount,
    following: profile.viewerRelationshipStatus === 'accepted',
    followsYou: profile.followsViewerStatus === 'accepted',
    previewBalance: null,
    sourceId: null,
    sourceAccountMode: 'unknown',
    copyEligible: false,
    performanceStatus: 'unavailable',
    syntheticDemo: profile.syntheticDemo,
    socialLinks: profile.socialLinks,
    profile: {
      joinedAt: profile.createdAt,
      rank,
      leverage: null,
      country: profile.country,
      timezone: null,
    },
    openTrades: [],
    closedPerformance: [],
    activities: [],
    chart: { series: [], growth: [], outcome: [] },
  }
}

function hydrateTrader(base: SocialTrader, rows: SocialTradeHistoryItem[], performance: Awaited<ReturnType<typeof fetchSocialProviderPerformance>>[number] | null, source: Awaited<ReturnType<typeof fetchSocialCopySources>>[number] | null): SocialTrader {
  const ordered = rows.slice().sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime())
  const closed = ordered.filter((trade): trade is SocialTradeHistoryItem & { closedAt: string; realizedProfit: number } => trade.status === 'closed' && trade.closedAt != null && trade.realizedProfit != null)
  const open = ordered.filter(trade => trade.status === 'open')
  let cumulative = 0
  const daily = new Map<string, { profit: number; loss: number }>()
  const growth = closed.map(trade => {
    cumulative += trade.realizedProfit
    const date = new Date(trade.closedAt)
    const key = date.toISOString().slice(0, 10)
    const bucket = daily.get(key) ?? { profit: 0, loss: 0 }
    if (trade.realizedProfit >= 0) bucket.profit += trade.realizedProfit
    else bucket.loss += Math.abs(trade.realizedProfit)
    daily.set(key, bucket)
    return {
      label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      acc_equity: Math.round(cumulative * 100) / 100,
    }
  })
  const outcome = [...daily.entries()].map(([key, value]) => ({
    key,
    label: new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    volume: value.profit + value.loss,
    profit: value.profit,
    loss: value.loss,
  }))
  return {
    ...base,
    roi: performance?.returnPercentage ?? null,
    winRate: performance?.winRate ?? null,
    maxDrawdown: performance?.maximumDrawdown ?? null,
    closedTrades: performance?.closedTradeCount ?? closed.length,
    sourceId: source?.sourceId ?? null,
    sourceAccountMode: source?.accountMode ?? 'unknown',
    copyEligible: source?.isCopyEligible === true && !base.syntheticDemo,
    performanceStatus: performance?.performanceStatus ?? 'unavailable',
    openTrades: open.map(trade => ({
      id: trade.tradeId,
      symbol: trade.symbol,
      side: trade.direction,
      openedAt: trade.openedAt,
      previewLot: null,
      previewStopLoss: null,
      previewTakeProfit: null,
    })),
    closedPerformance: closed.map(trade => ({
      id: trade.tradeId,
      symbol: trade.symbol,
      side: trade.direction,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      profit: trade.realizedProfit,
    })),
    activities: ordered.slice().reverse().map(trade => ({
      id: trade.tradeId,
      kind: trade.status === 'closed' ? 'close' : 'open',
      symbol: trade.symbol,
      side: trade.direction,
      at: trade.closedAt ?? trade.openedAt,
      profit: trade.realizedProfit,
    })),
    chart: {
      series: growth.length ? [{ id: 'acc_equity', name: `${base.displayName} realized P/L`, color: '#4ade80' }] : [],
      growth,
      outcome,
    },
  }
}

export function useSocialTradingPreview() {
  const social = useSocialFollow()
  const bases = useMemo(() => social.profiles.map((profile, index) => previewTrader(profile, index + 1)), [social.profiles])
  const [hydratedTraders, setHydratedTraders] = useState<SocialTrader[]>([])
  const [performanceLoading, setPerformanceLoading] = useState(false)

  useEffect(() => {
    let active = true
    if (!bases.length) return () => { active = false }
    void Promise.resolve().then(() => { if (active) setPerformanceLoading(true) })
    void Promise.all(social.profiles.map(async (profile, index) => {
      const base = bases[index]
      try {
        const [access, sources] = await Promise.all([
          fetchSocialTradeHistoryAccess(supabase, profile.profileUserId),
          fetchSocialCopySources(supabase, profile.profileUserId),
        ])
        if (!access.canView) return base
        const source = sources[0] ?? null
        const [performanceRows, history] = await Promise.all([
          fetchSocialProviderPerformance(supabase, profile.profileUserId),
          source ? fetchSocialTradeHistory(supabase, source.sourceId) : Promise.resolve([]),
        ])
        const performance = performanceRows.find(row => row.sourceId === source?.sourceId) ?? performanceRows[0] ?? null
        return hydrateTrader(base, history, performance, source)
      } catch {
        return base
      }
    })).then(next => {
      if (active) setHydratedTraders(next)
    }).finally(() => {
      if (active) setPerformanceLoading(false)
    })
    return () => { active = false }
  }, [bases, social.profiles])

  const traders = hydratedTraders.length === bases.length
    && hydratedTraders.every((trader, index) => trader.id === bases[index]?.id)
    ? hydratedTraders
    : bases
  return { ...social, traders, performanceLoading }
}
