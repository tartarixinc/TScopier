import type { AuthTranslations } from '../auth/types'
import type { ChannelWorkerTranslations } from '../channelWorker/types'
import type { ConfigureModalTranslations } from './configureModal/types'
import type { LandingTranslations } from './landing/types'

export interface GlobalSearchTranslations {
  placeholder: string
  noResults: string
  groupPages: string
  groupBrokers: string
  groupChannels: string
  shortcut: string
}

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
  settings: string
  help: string
  helpMenu: {
    title: string
    documentation: string
    liveChat: string
    whatsapp: string
    telegram: string
    status: string
    statusOperational: string
  }
  userMenu: {
    menuLabel: string
    profileSettings: string
    subscriptionBilling: string
    affiliateProgram: string
    signOut: string
  }
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

export interface DashboardLinkedAccountsTranslations {
  title: string
  subtitle: string
  empty: string
  colAccount: string
  colBroker: string
  colAccountType: string
  colBalance: string
  colPnl: string
  colPnlHint: string
  colOpenPnl: string
  colOpenPnlHint: string
  colWinRate: string
  colDd: string
  colStatus: string
  unnamedAccount: string
  statusActive: string
  statusPaused: string
  statusConnected: string
  accountTypeLive: string
  accountTypeDemo: string
  statusDisconnected: string
  reconnect: string
}

export interface DashboardTranslations {
  title: string
  totalBalance: string
  acrossAccounts: string
  todaysProfit: string
  /** Tooltip: how Today's profit is calculated vs broker terminal. */
  todaysProfitHint: string
  tradesTakenToday: string
  noClosedTradesToday: string
  openPnl: string
  openPnlNoOpen: string
  openPnlAcrossOneAccount: string
  openPnlAcrossAccounts: string
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
  channelProfitTitle: string
  channelProfitSubtitle: string
  channelProfitEmpty: string
  channelWorker: string
  noChannelWorkerLogs: string
  noData: string
  linkedAccounts: DashboardLinkedAccountsTranslations
}

export interface SignalHistoryPageTranslations {
  allChannels: string
  dateFrom: string
  dateTo: string
  presetAll: string
  presetToday: string
  preset7d: string
  preset30d: string
  presetCustom: string
  resetFilters: string
  totalFound: string
  noSignals: string
  updatesReceivedToday: string
  updatesReceivedLast7d: string
  updatesReceivedLast30d: string
  updatesReceivedTotal: string
  updatesReceivedThisWeek: string
  updatesReceivedThisMonth: string
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

export interface AccountConfigAddAccountModalTranslations {
  title: string
  subtitle: string
  footerHint: string
  comingSoonBadge: string
  comingSoonPlatform: string
}

export interface AccountConfigConnectFormTranslations {
  addAccountButton: string
  title: string
  accountLabel: string
  accountLabelPlaceholder: string
  platformLabel: string
  platformMt5: string
  platformMt4: string
  brokerServerLabel: string
  brokerServerHint: string
  brokerCompanySearchPlaceholder: string
  brokerCompanySearchEmpty: string
  brokerCompanySearchMinChars: string
  brokerCompanySearchNoResults: string
  brokerCompanySearchLoading: string
  brokerCompanySearchError: string
  brokerServerPickerTitle: string
  brokerServerSelectPrompt: string
  brokerServerManualToggle: string
  brokerServerManualLabel: string
  brokerServerManualHint: string
  mtLoginLabel: string
  mtLoginPlaceholder: string
  passwordLabel: string
  passwordPlaceholder: string
  passwordHint: string
  rememberPasswordLabel: string
  rememberPasswordHint: string
  connectButton: string
  validationRequired: string
  connectFailed: string
}

export interface AccountConfigBrokerListTranslations {
  statusPaused: string
  statusConnected: string
  statusError: string
  statusDisconnected: string
  copyTrades: string
  reconnect: string
  reconnectAll: string
  configure: string
  removeAria: string
  detailLogin: string
  detailAccountType: string
  accountTypeDemo: string
  accountTypeLive: string
  detailServer: string
  detailSignalChannels: string
  detailBalance: string
  detailEquity: string
  channelsNoneSelected: string
  channelsEmptySaveWarning: string
  channelsSignalChannel: string
  channelsAll: string
  relinkOne: string
  relinkMany: string
  reconnectDroppedOne: string
  reconnectDroppedMany: string
  connectErrorWrongPassword: string
  connectErrorWrongLogin: string
  connectErrorWrongServer: string
  connectErrorInvestorPassword: string
  connectErrorAccountDisabled: string
  connectErrorSessionExpired: string
  connectErrorUnknown: string
  reconnectFailed: string
  reconnectPasswordTitle: string
  reconnectPasswordBody: string
  reconnectPasswordLabel: string
  reconnectPasswordHint: string
  reconnectPasswordPlaceholder: string
  rememberPasswordLabel: string
  rememberPasswordHint: string
  clearStoredCredentials: string
  storedCredentialsActive: string
  deleteFailed: string
  deleteSessionExpired: string
  duplicateMtLogin: string
  deleteTitle: string
  deleteBody: string
  deleteConfirm: string
  connectedAccountsHeading: string
  connectedAccountsUnlimited: string
  brokerFilterLabel: string
  brokerFilterAll: string
  brokerFilterNoMatch: string
  accountSearchLabel: string
  accountSearchPlaceholder: string
  accountSearchNoMatch: string
}

export interface AccountConfigTranslations {
  brokersEmptyTitle: string
  brokersEmptySubtitle: string
  addAccount: AccountConfigAddAccountModalTranslations
  connectForm: AccountConfigConnectFormTranslations
  brokerList: AccountConfigBrokerListTranslations
  configureModal: ConfigureModalTranslations
}

export interface TradesTranslations {
  title: string
  subtitle: string
  filterOpen: string
  filterClosed: string
  filterAll: string
  refresh: string
  emptyTitle: string
  emptySubtitleConnect: string
  emptySubtitleOpen: string
  emptySubtitleClosed: string
  modalTitle: string
  close: string
  tradeSummary: string
  signalChannel: string
  telegramMessage: string
  parsedInstruction: string
  signalTime: string
  noLinkedSignal: string
  imageSignal: string
  loadingSignal: string
  loadSignalError: string
  viewDetails: string
  statusOpen: string
  statusClosed: string
  colBroker: string
  colEntry: string
  colSl: string
  colTp: string
  colLots: string
  colPnl: string
  colTime: string
  instructionAction: string
  instructionSymbol: string
  instructionEntry: string
  instructionEntryZone: string
  instructionSl: string
  instructionTp: string
  instructionLotSize: string
  instructionMessage: string
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
  noMtBroker: string
  noTradeHistory: string
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
  analysisTitle: string
  analysisSubtitle: string
  bestDay: string
  worstDay: string
  highestEquity: string
  lowestEquity: string
  bestTrade: string
  worstTrade: string
  profitByChannelTitle: string
  profitByChannelSubtitle: string
  symbolDistributionTitle: string
  symbolDistributionSubtitle: string
  distributionEmpty: string
  tradesCount: string
  unlinkedChannel: string
  otherSymbols: string
  onDate: string
}

export interface SettingsTranslations {
  title: string
  subtitle: string
  loadError: string
  saveError: string
  saved: string
  emailHint: string
  passwordHint: string
  passwordTooShort: string
  passwordMismatch: string
  passwordUpdated: string
  passwordError: string
  sections: {
    personal: string
    general: string
    security: string
  }
  personal: { title: string; description: string }
  general: { title: string; description: string }
  security: { title: string; description: string; updatePassword: string }
  fields: {
    firstName: string
    lastName: string
    username: string
    email: string
    country: string
    city: string
    mobile: string
    address: string
    baseCurrency: string
    timezone: string
    newPassword: string
    confirmPassword: string
  }
  placeholders: {
    address: string
    selectCountry: string
    selectTimezone: string
    selectCurrency: string
    searchCountry: string
    searchTimezone: string
    searchCurrency: string
    noMatches: string
  }
}

export interface CopierEngineSignalKeywordTranslations {
  entryPoint: string
  buy: string
  sell: string
  sl: string
  tp: string
  marketOrder: string
}

export interface CopierEngineUpdateKeywordTranslations {
  closeTp1: string
  closeTp2: string
  closeTp3: string
  closeTp4: string
  closeFull: string
  closeHalf: string
  closePartial: string
  breakEven: string
  setTp1: string
  setTp2: string
  setTp3: string
  setTp4: string
  setTp5: string
  setTp: string
  adjustTp: string
  setSl: string
  adjustSl: string
  delete: string
}

export interface CopierEngineAdditionalKeywordTranslations {
  layer: string
  closeAll: string
  deleteAll: string
  ignoreKeyword: string
  skipKeyword: string
  removeSl: string
  delayMsec: string
  preferEntry: string
  slInPips: string
  tpInPips: string
  delimiters: string
  allOrder: string
  readForwarded: string
  readImage: string
  firstPrice: string
  lastPrice: string
}

export interface CopierEnginePageTranslations {
  connectTelegram: string
  telegramNotConnectedTitle: string
  telegramNotConnectedBody: string
  tgConnectHeroTitle: string
  tgConnectHeroSubtitle: string
  tgConnectPhoneTitle: string
  tgConnectPhoneSubtitle: string
  tgConnectCodeTitle: string
  tgConnectCodeSubtitle: string
  tgConnectStepPhone: string
  tgConnectStepCode: string
  tgConnectStepTwoFa: string
  tgConnectStepChannels: string
  tgConnectTwoFaTitle: string
  tgConnectTwoFaSubtitle: string
  backToVerificationCode: string
  tgConnectStepsAria: string
  tgConnectHowItWorks1: string
  tgConnectHowItWorks2: string
  tgConnectHowItWorks3: string
  tgConnectPhoneWarning: string
  useDifferentNumber: string
  cancelConnect: string
  phoneLabel: string
  phonePlaceholder: string
  phoneHint: string
  sendCode: string
  verificationCode: string
  verificationPlaceholder: string
  sentTo: string
  twoFaPassword: string
  twoFaPlaceholder: string
  twoFaRequired: string
  verify: string
  back: string
  networkError: string
  failedSendCode: string
  verificationFailed: string
  failedLoadTgChannels: string
  telegramSessionExpired: string
  reconnectTelegram: string
  channelSearchPlaceholder: string
  noChannelSearchResults: string
  yourTelegramChannels: string
  telegramConnectedHint: string
  connected: string
  expand: string
  collapse: string
  disconnect: string
  channelsFound: string
  refreshAfterFix: string
  noTgChannelsTitle: string
  noTgChannelsSubtitle: string
  members: string
  added: string
  add: string
  configuredEmptyTitle: string
  configuredEmptySubtitle: string
  configuredEmptyConnectHint: string
  activeChannels: string
  configuredCount: string
  statusPaused: string
  removeAria: string
  analyzing: string
  profilePending: string
  profileAnalyzeFailed: string
  profileNoMessages: string
  profileType: string
  profileEntry: string
  profileTp: string
  profileSl: string
  connectedBrokers: string
  connectToBroker: string
  connectAllBrokers: string
  connectAllBrokersAria: string
  addBrokerConnectionAria: string
  removeBrokerConnectionAria: string
  noBrokersYet: string
  connectBrokerInConfig: string
  channelTelegramId: string
  invalidChannelIdentity: string
  manualIdentityRequired: string
  invalidChannelIdFormat: string
  invalidUsernameFormat: string
  keywordsTitle: string
  keywordsClose: string
  keywordsSave: string
  signalKeywordSection: string
  updateKeywordSection: string
  additionalKeywordSection: string
  signalKeywords: CopierEngineSignalKeywordTranslations
  updateKeywords: CopierEngineUpdateKeywordTranslations
  additionalKeywords: CopierEngineAdditionalKeywordTranslations
}

export interface ChannelsPageTranslations {
  title: string
  subtitle: string
  addChannel: string
  addFormTitle: string
  channelName: string
  channelNamePlaceholder: string
  usernameOptional: string
  usernamePlaceholder: string
  channelIdOptional: string
  channelIdPlaceholder: string
  channelIdHint: string
  nameRequired: string
  emptyTitle: string
  emptySubtitle: string
  statusPaused: string
  overridesTitle: string
  lotSizeOverride: string
  pipToleranceOverride: string
  useBrokerDefault: string
}

export interface BacktestOutcomeLabels {
  allTpHit: string
  tpThenBe: string
  partial: string
  tp1ThenSl: string
  slHit: string
  breakeven: string
  noData: string
  skipped: string
  open: string
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
  history: string
  signalBreakdown: string
  noActiveChannels: string
  configureHint: string
  signalChannel: string
  pullingSignals: string
  pullProfileSignals: string
  selectChannelError: string
  profileFirstError: string
  selectSymbolError: string
  profileImported: string
  profileCandidates: string
  profileNoTradeable: string
  profileSyncFailed: string
  noSymbolsInRange: string
  readyTitle: string
  readyMeta: string
  back: string
  symbolToBacktest: string
  runningDefault: string
  resultReady: string
  seeBacktestResult: string
  resultsTitle: string
  resultsSubtitle: string
  newRun: string
  totalPips: string
  winRate: string
  winLoss: string
  signalsLabel: string
  oneSignal: string
  nSignals: string
  channelFallback: string
  channelMore: string
  historyModalTitle: string
  historyModalSubtitle: string
  historyEmpty: string
  close: string
  statusCompleted: string
  statusFailed: string
  statusRunning: string
  statusCancelled: string
  noResults: string
  buy: string
  sell: string
  resultsPerPage: string
  showing: string
  resultModalTitle: string
  editSignal: string
  direction: string
  entry: string
  stopLoss: string
  takeProfits: string
  addTp: string
  removeTp: string
  rerunCheck: string
  rerunning: string
  deleteResult: string
  deleteConfirm: string
  deleteFailed: string
  rerunFailed: string
  invalidLevels: string
  unsavedHint: string
  pips: string
  riskReward: string
  duration: string
  eventTimeline: string
  noEvents: string
  outcomes: BacktestOutcomeLabels
  banners: {
    allTpHit: string
    slHit: string
    breakeven: string
    tpThenBe: string
    partialHit: string
    noMarketData: string
    skipped: string
    open: string
  }
  events: {
    tpHit: string
    slHit: string
    breakeven: string
  }
  priceLevels: {
    entry: string
    sl: string
    be: string
    tp: string
  }
  errors: {
    rateLimit: string
  }
}

export interface PricingTranslations {
  title: string
  subtitle: string
  skip: string
  monthly: string
  annual: string
  perMonth: string
  perYear: string
  save20: string
  billedAnnually: string
  extraAccountLabel: string
  extraAccountUnit: string
  extraAccountUnitAnnual: string
  subscribe: string
  startTrial: string
  trialDays: string
  features: string
  popular: string
  basicFeatures: string[]
  advancedFeatures: string[]
  extraAccountsSummary: string
  basic: {
    name: string
    description: string
  }
  advanced: {
    name: string
    description: string
  }
  billing: {
    title: string
    subtitle: string
    customerId: string
    credit: string
    purchaseSubscription: string
    memberSince: string
    nextRenewal: string
    currentPlan: string
    billed: string
    noActiveSubscription: string
    freePlan: string
    freePlanSummary: string
    basicPlanSummary: string
    advancedPlanSummary: string
    statusLine: string
    invoices: string
    invoicesHint: string
    invoiceNumber: string
    period: string
    date: string
    amount: string
    status: string
    downloadInvoice: string
    invoiceStatusPaid: string
    invoiceStatusDraft: string
    invoiceStatusOpen: string
    invoiceStatusVoid: string
    invoiceStatusUncollectible: string
    noInvoices: string
    loadInvoicesFailed: string
    subscriptionPlans: string
    subscriptionPlansIntro: string
    back: string
    next: string
    nextBilling: string
    extraAccounts: string
    extraAccountsSummary: string
    manageBilling: string
    noPlan: string
    statusActive: string
    statusTrialing: string
    statusCanceled: string
    statusPastDue: string
    trialEnds: string
    choosePlan: string
  }
  checkoutFailed: string
  paywall: {
    noPlanTitle: string
    noPlanReason: string
    upgradeTitle: string
    upgradeCta: string
    manageBilling: string
    updatePaymentTitle: string
    updatePaymentReason: string
    updatePayment: string
    brokerLimit: string
    channelLimit: string
    backtestLimit: string
    subscriptionRequired: string
    advancedFeature: string
  }
}

export interface Translations {
  auth: AuthTranslations
  channelWorker: ChannelWorkerTranslations
  nav: NavTranslations
  globalSearch: GlobalSearchTranslations
  common: CommonTranslations
  pricing: PricingTranslations
  landing: LandingTranslations
  accountConfig: AccountConfigTranslations
  dashboard: DashboardTranslations
  copierLogs: CopierLogsTranslations
  signalHistoryPage: SignalHistoryPageTranslations
  trades: TradesTranslations
  channelsPage: ChannelsPageTranslations
  copierEnginePage: CopierEnginePageTranslations
  backtest: BacktestTranslations
  marketNews: MarketNewsTranslations
  economicCalendar: EconomicCalendarTranslations
  performance: PerformanceTranslations
  settings: SettingsTranslations
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
    settings: PageMeta
  }
}
