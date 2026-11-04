import { useEffect, useMemo, useState } from 'react'
import { useSocialFollow } from './useSocialFollow'
import { fetchSocialCopySources, fetchSocialTraderLiveCopierCount } from '../lib/socialCopy'
import {
  fetchSocialProviderPerformance,
  fetchSocialTradeHistory,
  fetchSocialTradeHistoryAccess,
  type SocialTradeHistoryItem,
} from '../lib/socialTradeHistory'
import { eligibilityDiagnosticForReason } from '../lib/socialEligibility'
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
    closedTrades: null,
    openTradeCount: null,
    followerCount: profile.followerCount,
    rating: profile.averageRating,
    ratingCount: profile.reviewCount,
    following: profile.viewerRelationshipStatus === 'accepted',
    followsYou: profile.followsViewerStatus === 'accepted',
    previewBalance: profile.balance,
    accountEquity: profile.equity,
    sourceId: null,
    sourceLabel: null,
    sourceProvider: null,
    sourcePlatform: null,
    sourceAccountMode: 'unknown',
    sources: [],
    copyEligible: false,
    copyEligibilityReason: 'source_missing',
    performanceStatus: 'unavailable',
    performanceStatusReason: 'not_loaded',
    performanceError: null,
    historyAvailable: false,
    historyComplete: false,
    performancePeriodStartedAt: null,
    performancePeriodEndedAt: null,
    liveCopiers: null,
    syntheticDemo: profile.syntheticDemo,
    socialLinks: profile.socialLinks,
    slug: profile.slug,
    providerStatus: profile.providerStatus,
    accountKind: profile.accountKind,
    accountPlatform: profile.platform,
    accountCurrency: profile.currency,
    accountSnapshotAt: profile.snapshotAt,
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed.'
}

export function hydrateTrader(
  base: SocialTrader,
  history: SocialTradeHistoryItem[] | null,
  performance: Awaited<ReturnType<typeof fetchSocialProviderPerformance>>[number] | null,
  source: Awaited<ReturnType<typeof fetchSocialCopySources>>[number] | null,
  performanceError: string | null = null,
  sources: Awaited<ReturnType<typeof fetchSocialCopySources>> = source ? [source] : [],
  liveCopiers: number | null = null,
): SocialTrader {
  const rows = history ?? []
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
  const historyClosedRows = ordered.filter(trade => trade.status === 'closed')
  const historyComplete = history != null
    && performance != null
    // 'stale' keeps the last synced history; the row is flagged stale separately.
    && (performance.performanceStatus === 'available' || performance.performanceStatus === 'stale' || performance.performanceStatus === 'no_history')
    && open.length === performance.openTradeCount
    && historyClosedRows.length === performance.closedTradeCount
    && closed.length === historyClosedRows.length
  const syntheticDemo = base.syntheticDemo === true || source?.isSynthetic === true || performance?.isSynthetic === true
  return {
    ...base,
    roi: performance?.returnPercentage ?? null,
    winRate: historyComplete ? performance.winRate : null,
    maxDrawdown: performance?.maximumDrawdown ?? null,
    closedTrades: historyComplete ? performance.closedTradeCount : null,
    openTradeCount: historyComplete ? performance.openTradeCount : null,
    sourceId: source?.sourceId ?? null,
    sourceLabel: source?.label ?? null,
    sourceProvider: source?.provider ?? null,
    sourcePlatform: source?.platform ?? null,
    sourceAccountMode: source?.accountMode ?? 'unknown',
    sources,
    copyEligible: source?.isCopyEligible === true,
    copyEligibilityReason: source?.eligibilityReason ?? performance?.eligibilityReason ?? 'source_missing',
    performanceStatus: performance?.performanceStatus ?? 'unavailable',
    performanceStatusReason: performance?.statusReason ?? null,
    performanceError,
    historyAvailable: history != null,
    historyComplete,
    performancePeriodStartedAt: performance?.periodStartedAt ?? null,
    performancePeriodEndedAt: performance?.periodEndedAt ?? null,
    liveCopiers,
    syntheticDemo,
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
      const [accessResult, sourcesResult, liveCopiersResult] = await Promise.allSettled([
        fetchSocialTradeHistoryAccess(supabase, profile.profileUserId),
        fetchSocialCopySources(supabase, profile.profileUserId),
        fetchSocialTraderLiveCopierCount(supabase, profile.profileUserId),
      ])
      const liveCopiers = liveCopiersResult.status === 'fulfilled' ? liveCopiersResult.value : null
      const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value : []
      const source = sources.find(item => item.isCopyEligible) ?? sources[0] ?? null
      if (accessResult.status === 'rejected') {
        return hydrateTrader(base, null, null, source, `Trade-history access check failed: ${errorMessage(accessResult.reason)}`, sources, liveCopiers)
      }
      if (!accessResult.value.canView) {
        return hydrateTrader(base, null, null, source, 'This trader has not shared source-account history with you.', sources, liveCopiers)
      }
      if (!source) {
        const detail = sourcesResult.status === 'rejected'
          ? `Copy-source request failed: ${errorMessage(sourcesResult.reason)}`
          : eligibilityDiagnosticForReason('source_not_published').explanation
        return hydrateTrader(base, null, null, null, detail, sources, liveCopiers)
      }
      const [performanceResult, historyResult] = await Promise.allSettled([
        fetchSocialProviderPerformance(supabase, profile.profileUserId),
        fetchSocialTradeHistory(supabase, source.sourceId),
      ])
      const performanceRows = performanceResult.status === 'fulfilled' ? performanceResult.value : []
      const performance = performanceRows.find(row => row.sourceId === source.sourceId) ?? null
      const history = historyResult.status === 'fulfilled' ? historyResult.value : null
      const diagnostics = [
        performanceResult.status === 'rejected' ? `Performance request failed: ${errorMessage(performanceResult.reason)}` : null,
        historyResult.status === 'rejected' ? `Trade-history request failed: ${errorMessage(historyResult.reason)}` : null,
        performanceResult.status === 'fulfilled' && !performance ? 'The selected source was missing from the performance response.' : null,
      ].filter((message): message is string => Boolean(message))
      return hydrateTrader(base, history, performance, source, diagnostics.join(' ') || null, sources, liveCopiers)
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
