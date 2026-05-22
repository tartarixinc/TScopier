export interface LandingFeatureTranslation {
  title: string
  description: string
}

export type LandingFeatureVisualId =
  | 'copier'
  | 'filters'
  | 'backtest'
  | 'logs'
  | 'news'
  | 'integrations'

export interface LandingFeatureShowcase {
  eyebrow: string
  title: string
  description: string
  visual: LandingFeatureVisualId
}

export type LandingFilterDecision = 'allow' | 'ignore'

export interface LandingFilterRuleVisual {
  label: string
  example: string
  decision: LandingFilterDecision
}

export interface LandingLogEntryVisual {
  stage: string
  message: string
  latency: string
}

export interface LandingCalendarEventVisual {
  name: string
  time: string
  impact: 'high' | 'med'
}

export interface LandingNewsHeadlineVisual {
  label: string
}

export type LandingBacktestPipsTone = 'good' | 'bad' | 'neutral'

export interface LandingBacktestSignalVisual {
  symbol: string
  side: 'buy' | 'sell'
  timestamp: string
  outcome: string
  pips: string
  pipsTone: LandingBacktestPipsTone
  duration: string
}

export interface LandingBacktestVisualCopy {
  resultsTitle: string
  resultsSubtitle: string
  newRunLabel: string
  totalPipsLabel: string
  totalPips: string
  winRateLabel: string
  winRate: string
  winLossLabel: string
  winLoss: string
  signalsLabel: string
  signalsCount: string
  signalsListLabel: string
  signals: LandingBacktestSignalVisual[]
}

export interface LandingFeatureVisualsCopy {
  copier: {
    telegramLabel: string
    channelName: string
    channelMeta: string
    hubLabel: string
    mt4Label: string
    mt4Meta: string
    mt5Label: string
    mt5Meta: string
    pillLayering: string
    pillLots: string
    pillChannels: string
  }
  filters: {
    allowLabel: string
    ignoreLabel: string
    rules: LandingFilterRuleVisual[]
  }
  backtest: LandingBacktestVisualCopy
  logs: {
    hubLabel: string
    pillLatency: string
    pillLive: string
    entries: LandingLogEntryVisual[]
  }
  news: {
    calendarTitle: string
    impactHigh: string
    impactMed: string
    pillCalendar: string
    events: LandingCalendarEventVisual[]
    headlines: LandingNewsHeadlineVisual[]
  }
  integrations: {
    hubLabel: string
    labels: {
      telegram: string
      mt4: string
      mt5: string
    }
  }
}

export interface LandingStepTranslation {
  title: string
  description: string
}

export interface LandingReviewTranslation {
  quote: string
  author: string
}

export interface LandingPlanTeaserTranslation {
  name: string
  description: string
  priceLabel: string
  cta: string
}

export type LandingHeroStatTone = 'good' | 'bad' | 'neutral'

export type LandingHeroHeadlineStatKey =
  | 'totalBalance'
  | 'todaysProfit'
  | 'tradesTakenToday'
  | 'openPnl'

export type LandingHeroOverviewStatKey =
  | 'activeSignalChannels'
  | 'openTrades'
  | 'tradingAccountsConnected'
  | 'tradesCopiedToday'

export interface LandingHeroHeadlineStat {
  key: LandingHeroHeadlineStatKey
  value: string
  sub: string
  valueTone: LandingHeroStatTone
  showHint?: boolean
}

export interface LandingHeroOverviewStat {
  key: LandingHeroOverviewStatKey
  value: string
  showAdd?: boolean
}

export type LandingHeroCopierLogStatus = 'executed' | 'parsed' | 'skipped' | 'failed' | 'pending'

export interface LandingHeroCopierLogRow {
  status: LandingHeroCopierLogStatus
  channel: string
  symbol: string
  type: string
  side: 'buy' | 'sell'
  time: string
}

export interface LandingHeroChannelWorkerLog {
  message: string
  time: string
}

export interface LandingHeroDashboardCopy {
  headlineStats: LandingHeroHeadlineStat[]
  overviewStats: LandingHeroOverviewStat[]
  channelWorkerLogs: LandingHeroChannelWorkerLog[]
  copierLogRows: LandingHeroCopierLogRow[]
}

export interface LandingTranslations {
  nav: {
    product: string
    features: string
    pricing: string
    signIn: string
    getStarted: string
    menuOpen: string
    menuClose: string
  }
  hero: {
    trustedBy: string
    avatarAlts: [string, string, string]
    headline: string
    headlineAccent: string
    subheadline: string
    primaryCta: string
    secondaryCta: string
    imageAlt: string
    previewUrl: string
    dashboard: LandingHeroDashboardCopy
  }
  whyChoose: {
    title: string
    subtitle: string
    items: LandingFeatureTranslation[]
  }
  features: {
    eyebrow: string
    title: string
    subtitle: string
    showcases: LandingFeatureShowcase[]
    visuals: LandingFeatureVisualsCopy
  }
  steps: {
    title: string
    subtitle: string
    items: LandingStepTranslation[]
  }
  reviews: {
    title: string
    trustpilotLabel: string
    items: LandingReviewTranslation[]
  }
  pricing: {
    title: string
    subtitle: string
    perMonth: string
    popular: string
    viewPlans: string
    basic: LandingPlanTeaserTranslation
    advanced: LandingPlanTeaserTranslation
  }
  footer: {
    copyright: string
    docs: string
    status: string
    openApp: string
  }
}
