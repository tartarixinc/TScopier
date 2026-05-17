import type { AuthTranslations } from '../auth/types'
import type { ChannelWorkerTranslations } from '../channelWorker/types'

export interface NavTranslations {
  sections: {
    general: string
    signals: string
    tradingTools: string
    feedback: string
    growth: string
    membership: string
  }
  items: {
    dashboard: string
    configuration: string
    trades: string
    channels: string
    backtest: string
    copierLogs: string
    signalHistory: string
    marketNews: string
    economicCalendar: string
    performance: string
    contactSupport: string
    featureRequest: string
    partnerWithUs: string
    affiliateProgram: string
    billing: string
    subscriptions: string
  }
  signOut: string
  search: string
  openMenu: string
  closeMenu: string
  expandSidebar: string
  collapseSidebar: string
  planFree: string
}

export interface CommonTranslations {
  comingSoon: string
  underDevelopment: string
  loading: string
  refresh: string
  save: string
  cancel: string
  delete: string
  edit: string
  add: string
  all: string
  yes: string
  no: string
  preview: string
  synced: string
  won: string
  lost: string
  breakeven: string
  vsYesterday: string
  perPage: string
  previous: string
  next: string
  showingRange: string
  noResults: string
  show: string
  results: string
}

export interface PageMeta {
  title: string
  description: string
}

export interface DashboardTranslations {
  title: string
  totalBalance: string
  acrossAccounts: string
  todaysProfit: string
  tradesTakenToday: string
  noClosedTradesToday: string
  openPnl: string
  acrossAllAccounts: string
  activeSignalChannels: string
  connectedTelegramChannels: string
  manageChannels: string
  openTrades: string
  activeBrokerPositions: string
  tradingAccountsConnected: string
  addOrManageAccounts: string
  tradesCopiedToday: string
  executedFromSignals: string
  aiExpertLog: string
  copierLogs: string
  viewAll: string
  noLogsYet: string
  healthStable: string
  healthDegraded: string
  healthOffline: string
  tradeOutcomeTitle: string
  tradeOutcomeSubtitle: string
  tradeOutcomeEmpty: string
  chartProfit: string
  chartLoss: string
  accountGrowthTitle: string
  accountGrowthSubtitle: string
  accountGrowthEmpty: string
  channelWorker: string
  noChannelWorkerLogs: string
  noData: string
}

export interface CopierLogsTranslations {
  title: string
  subtitle: string
  filterAll: string
  filterExecuted: string
  filterSkipped: string
  filterFailed: string
  filterPending: string
  colStatus: string
  colReason: string
  colChannel: string
  colSymbol: string
  colMessage: string
  colType: string
  colTime: string
  emptyTitle: string
  emptySubtitle: string
  statusExecuted: string
  statusSkipped: string
  statusFailed: string
  statusPending: string
  statusParsed: string
}

export interface TradesTranslations {
  title: string
  subtitle: string
  filterOpen: string
  filterClosed: string
  filterAll: string
  refresh: string
}

export interface EconomicCalendarTranslations {
  title: string
  subtitle: string
  from: string
  to: string
  country: string
  countryAll: string
  impact: string
  impactAll: string
  impactHigh: string
  impactMedium: string
  impactLow: string
  newsFilter: string
  actual: string
  forecast: string
  previous: string
  loadError: string
  empty: string
  lastUpdated: string
  relatedNews: string
  relatedNewsEmpty: string
  readArticle: string
  dataByFmp: string
}

export interface MarketNewsTranslations {
  title: string
  subtitle: string
  symbol: string
  symbolAll: string
  forexBadge: string
  readArticle: string
  lastUpdated: string
  loadError: string
  emptyTitle: string
  emptySubtitle: string
  emptyFilterTitle: string
  emptyFilterSubtitle: string
  moreHeadlines: string
  dataByFmp: string
}

export interface PerformanceTranslations {
  title: string
  subtitle: string
  period7d: string
  period30d: string
  period90d: string
  periodAll: string
  lastUpdated: string
  realizedPnl: string
  closedTrades: string
  winRate: string
  winLoss: string
  profitFactor: string
  avgRoi: string
  accountsTracked: string
  noBaseline: string
  maxDrawdown: string
  outcomeTitle: string
  outcomeTitleAll: string
  outcomeSubtitle: string
  outcomeEmpty: string
  accountsTitle: string
  accountsSubtitle: string
  viewTrades: string
  accountsEmpty: string
  colAccount: string
  colBroker: string
  colEquity: string
  colRoi: string
  colWinRate: string
  colMaxDrawdown: string
  configure: string
  baselineNote: string
}

export interface BacktestTranslations {
  title: string
  subtitle: string
  channels: string
  symbols: string
  from: string
  to: string
  timeframe: string
  execution: string
  executionTick: string
  executionBars: string
  strategy: string
  breakevenAfterTp: string
  breakevenDisabled: string
  intrabarPriority: string
  intrabarSlFirst: string
  intrabarTpFirst: string
  account: string
  startingBalance: string
  sizing: string
  sizingFixed: string
  sizingRisk: string
  lotSize: string
  riskPercent: string
  runBacktest: string
  recentRuns: string
  signalBreakdown: string
  noActiveChannels: string
}

export interface Translations {
  auth: AuthTranslations
  channelWorker: ChannelWorkerTranslations
  nav: NavTranslations
  common: CommonTranslations
  dashboard: DashboardTranslations
  copierLogs: CopierLogsTranslations
  trades: TradesTranslations
  backtest: BacktestTranslations
  marketNews: MarketNewsTranslations
  economicCalendar: EconomicCalendarTranslations
  performance: PerformanceTranslations
  pages: {
    accountConfiguration: PageMeta
    contactSupport: PageMeta
    featureRequest: PageMeta
    partnerWithUs: PageMeta
    affiliateProgram: PageMeta
    billing: PageMeta
    subscriptions: PageMeta
    marketNews: PageMeta
    economicCalendar: PageMeta
    performance: PageMeta
    portfolio: PageMeta
    analysisHub: PageMeta
    signalHistory: PageMeta
    copierEngine: PageMeta
  }
}
