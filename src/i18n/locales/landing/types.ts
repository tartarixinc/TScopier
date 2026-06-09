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

export type LandingCopierLogType =
  | 'buy'
  | 'sell'
  | 'close'
  | 'breakeven'
  | 'partial_profit'
  | 'partial_breakeven'
  | 'modify'

export interface LandingCopierLogRowVisual {
  symbol: string | null
  type: LandingCopierLogType
  time: string
}

export interface LandingCopierLogsVisualCopy {
  rows: LandingCopierLogRowVisual[]
}

export type LandingCalendarImpact = 'high' | 'medium' | 'low'

export type LandingCalendarActualTone = 'good' | 'bad' | 'neutral'

export interface LandingCalendarEventVisual {
  time: string
  currency: string
  name: string
  impact: LandingCalendarImpact
  actual: string
  forecast: string
  previous: string
  actualTone: LandingCalendarActualTone
}

export interface LandingNewsArticleVisual {
  headline: string
  source: string
  relativeTime: string
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
  logs: LandingCopierLogsVisualCopy
  news: {
    dayHeading: string
    events: LandingCalendarEventVisual[]
    articles: LandingNewsArticleVisual[]
  }
}

export type LandingBentoIcon =
  | 'zap'
  | 'cloud'
  | 'link'
  | 'clock'
  | 'activity'
  | 'chart'
  | 'layers'
  | 'settings'
  | 'messages'
  | 'history'

export type LandingBentoCardLayout = 'tall' | 'short' | 'featured'

export type LandingBentoMetricVariant = 'teal' | 'neutral' | 'amber'

export interface LandingBentoCard {
  label: string
  metric: string
  metricVariant: LandingBentoMetricVariant
  description: string
  layout: LandingBentoCardLayout
  icon: LandingBentoIcon
}

export type LandingStepVisualId = 'telegram' | 'configure' | 'copy'

export interface LandingStepItem {
  title: string
  description: string
  visual: LandingStepVisualId
}

export interface LandingStepsTelegramChannelVisual {
  name: string
  username: string
  active: boolean
  brokers: string[]
}

export interface LandingStepsConfigureTpVisual {
  label: string
  percent: string
}

export interface LandingStepsConfigureFilterVisual {
  label: string
  decision: LandingFilterDecision
}

export interface LandingStepsCopyLogVisual {
  symbol: string
  type: 'buy' | 'sell'
  time: string
}

export interface LandingStepsVisualsCopy {
  telegram: {
    channels: LandingStepsTelegramChannelVisual[]
  }
  configure: {
    accountName: string
    login: string
    lotSize: string
    rangeLabel: string
    rangeValue: string
    tpRows: LandingStepsConfigureTpVisual[]
    filters: LandingStepsConfigureFilterVisual[]
  }
  copy: {
    workerLogs: { message: string; time: string }[]
    logRows: LandingStepsCopyLogVisual[]
  }
}

export interface LandingReviewTranslation {
  quote: string
  author: string
  role?: string
}

export interface LandingComparisonRow {
  aspect: string
  other: string
  tscopier: string
}

export interface LandingFaqItem {
  question: string
  answer: string
}

export type LandingPlanComparisonValue = 'yes' | 'no' | 'partial' | string

export interface LandingPlanComparisonRow {
  feature: string
  basic: LandingPlanComparisonValue
  advanced: LandingPlanComparisonValue
  custom: LandingPlanComparisonValue
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

export interface LandingHeroLiveMoney {
  /** Starting amount when the hero preview mounts. */
  from: number
  /** Soft ceiling; ticks hover just below with small jitter. */
  cap: number
  stepMin: number
  stepMax: number
  /** Prefix with + for P/L style values. */
  signed?: boolean
}

export interface LandingHeroHeadlineStat {
  key: LandingHeroHeadlineStatKey
  /** Static fallback (reduced motion) and SEO; omit when `live` is set. */
  value?: string
  live?: LandingHeroLiveMoney
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
    faq: string
    docs: string
    signIn: string
    getStarted: string
    dashboard: string
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
    eyebrow: string
    title: string
    cards: LandingBentoCard[]
  }
  features: {
    eyebrow: string
    title: string
    subtitle: string
    showcases: LandingFeatureShowcase[]
    visuals: LandingFeatureVisualsCopy
  }
  steps: {
    eyebrow: string
    title: string
    subtitle: string
    items: LandingStepItem[]
    visuals: LandingStepsVisualsCopy
  }
  faq: {
    eyebrow: string
    title: string
    subtitle: string
    items: LandingFaqItem[]
  }
  reviews: {
    title: string
    trustpilotLabel: string
    items: LandingReviewTranslation[]
  }
  comparison: {
    eyebrow: string
    title: string
    subtitle: string
    otherLabel: string
    tscopierLabel: string
    cta: string
    rows: LandingComparisonRow[]
  }
  pricing: {
    title: string
    subtitle: string
  }
  planComparison: {
    eyebrow: string
    title: string
    subtitle: string
    basicColumn: string
    advancedColumn: string
    customColumn: string
    rows: LandingPlanComparisonRow[]
  }
  pricingFaq: {
    eyebrow: string
    title: string
    subtitle: string
    items: LandingFaqItem[]
  }
  pricingSocialProof: {
    banner: string
    purchaseToast: string
    timeAgoJustNow: string
    timeAgoOneMinute: string
  }
  pricingSnippet: {
    basic: string
    advanced: string
  }
  footer: {
    cta: {
      title: string
      subtitle: string
      primary: string
      secondary: string
    }
    tagline: string
    columns: {
      product: string
      resources: string
      account: string
    }
    links: {
      overview: string
      features: string
      pricing: string
      howItWorks: string
      faq: string
      docs: string
      status: string
      telegram: string
      riskDisclaimer: string
      termsOfService: string
      privacyPolicy: string
      cookiePolicy: string
      signIn: string
      signUp: string
      openApp: string
    }
    platforms: string
    copyright: string
    disclaimer: string
  }
}
