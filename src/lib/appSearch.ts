import type { LucideIcon } from 'lucide-react'
import type { Translations } from '../i18n/locales/types'

export type AppSearchResultKind = 'page' | 'broker' | 'channel'

export interface AppSearchResult {
  id: string
  kind: AppSearchResultKind
  title: string
  subtitle?: string
  path: string
  sectionLabel?: string
  keywords: string[]
}

export interface AppSearchPageDef {
  path: string
  title: string
  subtitle?: string
  sectionLabel: string
  keywords?: string[]
}

/** Static navigable pages for the header search index. */
export function buildAppSearchPages(t: Translations): AppSearchPageDef[] {
  const p = t.pages
  return [
    { path: '/dashboard', title: t.nav.items.dashboard, sectionLabel: t.nav.sections.general, subtitle: t.dashboard.title, keywords: ['home', 'overview'] },
    { path: '/account-configuration', title: t.nav.items.configuration, sectionLabel: t.nav.sections.general, subtitle: p.accountConfiguration.description, keywords: ['broker', 'mt4', 'mt5', 'account', 'copier'] },
    { path: '/account-trades', title: t.nav.items.trades, sectionLabel: t.nav.sections.general, keywords: ['positions', 'orders', 'history', 'trades'] },
    { path: '/settings', title: t.nav.settings, sectionLabel: t.nav.sections.general, subtitle: p.settings.description, keywords: ['profile', 'password', 'timezone'] },
    { path: '/copier-engine', title: t.nav.items.channels, sectionLabel: t.nav.sections.signals, subtitle: p.copierEngine.description, keywords: ['telegram', 'signals'] },
    { path: '/backtest', title: t.nav.items.backtest, sectionLabel: t.nav.sections.signals, subtitle: t.backtest.subtitle, keywords: ['simulate', 'test'] },
    { path: '/copier-logs', title: t.nav.items.copierLogs, sectionLabel: t.nav.sections.signals, keywords: ['logs', 'executed', 'skipped'] },
    { path: '/signal-history', title: t.nav.items.signalHistory, sectionLabel: t.nav.sections.signals, subtitle: p.signalHistory.description, keywords: ['parsed', 'messages'] },
    { path: '/performance', title: t.nav.items.performance, sectionLabel: t.nav.sections.signals, subtitle: p.performance.description, keywords: ['roi', 'win rate', 'stats'] },
    { path: '/market-news', title: t.nav.items.marketNews, sectionLabel: t.nav.sections.tradingTools, subtitle: p.marketNews.description, keywords: ['news', 'forex'] },
    { path: '/economic-calendar', title: t.nav.items.economicCalendar, sectionLabel: t.nav.sections.tradingTools, subtitle: p.economicCalendar.description, keywords: ['events', 'calendar'] },
    { path: '/contact-support', title: t.nav.items.contactSupport, sectionLabel: t.nav.sections.feedback, subtitle: p.contactSupport.description },
    { path: '/feature-request', title: t.nav.items.featureRequest, sectionLabel: t.nav.sections.feedback, subtitle: p.featureRequest.description },
    { path: '/partner-with-us', title: t.nav.items.partnerWithUs, sectionLabel: t.nav.sections.growth, subtitle: p.partnerWithUs.description },
    { path: '/affiliate-program', title: t.nav.items.affiliateProgram, sectionLabel: t.nav.sections.growth, subtitle: p.affiliateProgram.description },
    { path: '/billing', title: t.nav.items.billing, sectionLabel: t.nav.sections.membership, subtitle: p.billing.description },
    { path: '/subscriptions', title: t.nav.items.subscriptions, sectionLabel: t.nav.sections.membership, subtitle: p.subscriptions.description },
    { path: '/portfolio', title: p.portfolio.title, sectionLabel: t.nav.sections.general, subtitle: p.portfolio.description },
    { path: '/analysis-hub', title: p.analysisHub.title, sectionLabel: t.nav.sections.tradingTools, subtitle: p.analysisHub.description },
  ]
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

function scoreText(haystack: string, query: string): number {
  const h = normalizeForSearch(haystack)
  const q = normalizeForSearch(query.trim())
  if (!q) return 1
  if (h === q) return 100
  if (h.startsWith(q)) return 80
  if (h.includes(q)) return 50
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every(t => h.includes(t))) return 40
  return 0
}

export function scoreSearchResult(item: AppSearchResult, query: string): number {
  let score = scoreText(item.title, query) * 2
  if (item.subtitle) score = Math.max(score, scoreText(item.subtitle, query))
  if (item.sectionLabel) score = Math.max(score, scoreText(item.sectionLabel, query))
  score = Math.max(score, scoreText(item.path, query))
  for (const kw of item.keywords) {
    score = Math.max(score, scoreText(kw, query))
  }
  return score
}

export function filterSearchResults(items: AppSearchResult[], query: string, limit = 12): AppSearchResult[] {
  const q = query.trim()
  if (!q) {
    return items.slice(0, limit)
  }
  return items
    .map(item => ({ item, score: scoreSearchResult(item, q) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map(row => row.item)
}

export type SearchResultGroup = {
  kind: AppSearchResultKind
  label: string
  items: AppSearchResult[]
}

export function groupSearchResults(
  items: AppSearchResult[],
  labels: { pages: string; brokers: string; channels: string },
): SearchResultGroup[] {
  const pages = items.filter(i => i.kind === 'page')
  const brokers = items.filter(i => i.kind === 'broker')
  const channels = items.filter(i => i.kind === 'channel')
  const out: SearchResultGroup[] = []
  if (pages.length) out.push({ kind: 'page', label: labels.pages, items: pages })
  if (brokers.length) out.push({ kind: 'broker', label: labels.brokers, items: brokers })
  if (channels.length) out.push({ kind: 'channel', label: labels.channels, items: channels })
  return out
}

export type SearchIconMap = Record<AppSearchResultKind, LucideIcon>
