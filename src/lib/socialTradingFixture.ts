import type { AccountGrowthSeries, TradeVolumeDay } from './dashboardCharts'

export type SocialTradeSide = 'buy' | 'sell'

export interface SocialOpenTrade {
  id: string
  symbol: string
  side: SocialTradeSide
  openedAt: string
  /** Demo-only execution-preview values; never used by trade execution. */
  previewLot: number
  previewStopLoss: number | null
  previewTakeProfit: number | null
}

export interface SocialClosedTrade {
  id: string
  symbol: string
  side: SocialTradeSide
  openedAt: string
  closedAt: string
  profit: number
}

export interface SocialActivity {
  id: string
  kind: 'open' | 'close'
  symbol: string
  side: SocialTradeSide
  at: string
  profit: number | null
}

export interface SocialTraderChart {
  series: AccountGrowthSeries[]
  growth: Array<Record<string, string | number>>
  outcome: TradeVolumeDay[]
}

export type SocialAccess = 'open' | 'private'

export interface SocialTrader {
  id: string
  displayName: string
  username: string
  isYou: boolean
  /** Open traders can be copied immediately. Private traders require an accepted request. */
  access: SocialAccess
  allowFollowing: boolean
  roi: number
  winRate: number
  maxDrawdown: number
  closedTrades: number
  followerCount: number
  following: boolean
  followsYou: boolean
  /** Demo-only source balance used to illustrate proportional sizing. */
  previewBalance: number
  openTrades: SocialOpenTrade[]
  closedPerformance: SocialClosedTrade[]
  activities: SocialActivity[]
  chart: SocialTraderChart
}

const GROWTH_LABELS = ['Sep 29', 'Sep 30', 'Oct 1', 'Oct 2', 'Oct 3', 'Oct 6', 'Oct 7']

function chartFor(name: string, start: number, steps: number[], days: Array<[number, number]>): SocialTraderChart {
  let equity = start
  const growth = steps.map((step, index) => {
    equity += step
    return { label: GROWTH_LABELS[index] ?? '', acc_equity: Math.round(equity) }
  })
  return {
    series: [{ id: 'equity', name, color: '#0d9488' }],
    growth,
    outcome: days.map(([profit, loss], index) => ({
      key: GROWTH_LABELS[index] ?? String(index),
      label: GROWTH_LABELS[index] ?? '',
      volume: 0,
      profit,
      loss,
    })),
  }
}

export const SOCIAL_TRADERS: SocialTrader[] = [
  {
    id: 'you',
    displayName: 'You',
    username: 'you',
    isYou: true,
    access: 'open',
    allowFollowing: true,
    roi: 18.4,
    winRate: 61,
    maxDrawdown: 7.2,
    closedTrades: 42,
    followerCount: 2,
    following: false,
    followsYou: false,
    previewBalance: 10590,
    openTrades: [
      { id: 'you-o1', symbol: 'EURUSD', side: 'buy', openedAt: '2026-10-07T08:15:00Z', previewLot: 0.4, previewStopLoss: 1.1642, previewTakeProfit: 1.1768 },
      { id: 'you-o2', symbol: 'XAUUSD', side: 'sell', openedAt: '2026-10-07T11:40:00Z', previewLot: 0.2, previewStopLoss: 2668.5, previewTakeProfit: 2634 },
    ],
    closedPerformance: [
      { id: 'you-c1', symbol: 'GBPJPY', side: 'buy', openedAt: '2026-10-06T07:05:00Z', closedAt: '2026-10-06T15:20:00Z', profit: 186 },
      { id: 'you-c2', symbol: 'NAS100', side: 'sell', openedAt: '2026-10-05T13:10:00Z', closedAt: '2026-10-05T18:45:00Z', profit: -74 },
      { id: 'you-c3', symbol: 'USDJPY', side: 'buy', openedAt: '2026-10-03T09:00:00Z', closedAt: '2026-10-03T16:30:00Z', profit: 240 },
    ],
    activities: [
      { id: 'you-a1', kind: 'open', symbol: 'XAUUSD', side: 'sell', at: '2026-10-07T11:40:00Z', profit: null },
      { id: 'you-a2', kind: 'open', symbol: 'EURUSD', side: 'buy', at: '2026-10-07T08:15:00Z', profit: null },
      { id: 'you-a3', kind: 'close', symbol: 'GBPJPY', side: 'buy', at: '2026-10-06T15:20:00Z', profit: 186 },
      { id: 'you-a4', kind: 'close', symbol: 'NAS100', side: 'sell', at: '2026-10-05T18:45:00Z', profit: -74 },
    ],
    chart: chartFor('You', 10000, [120, -40, 210, 80, -30, 160, 90], [
      [220, 40], [80, 120], [310, 20], [140, 60], [40, 90], [260, 30], [180, 50],
    ]),
  },
  {
    id: 'amira-hassan',
    displayName: 'Amira Hassan',
    username: 'amira',
    isYou: false,
    access: 'open',
    allowFollowing: true,
    roi: 34.2,
    winRate: 68,
    maxDrawdown: 5.1,
    closedTrades: 96,
    followerCount: 128,
    following: true,
    followsYou: false,
    previewBalance: 26720,
    openTrades: [
      { id: 'amira-o1', symbol: 'XAUUSD', side: 'buy', openedAt: '2026-10-07T06:20:00Z', previewLot: 1, previewStopLoss: 2641.5, previewTakeProfit: 2688 },
      { id: 'amira-o2', symbol: 'EURUSD', side: 'sell', openedAt: '2026-10-06T14:05:00Z', previewLot: 0.6, previewStopLoss: 1.1775, previewTakeProfit: 1.163 },
    ],
    closedPerformance: [
      { id: 'amira-c1', symbol: 'US30', side: 'buy', openedAt: '2026-10-06T08:00:00Z', closedAt: '2026-10-06T19:10:00Z', profit: 420 },
      { id: 'amira-c2', symbol: 'GBPUSD', side: 'sell', openedAt: '2026-10-04T10:15:00Z', closedAt: '2026-10-04T17:40:00Z', profit: 155 },
      { id: 'amira-c3', symbol: 'NAS100', side: 'buy', openedAt: '2026-10-02T12:00:00Z', closedAt: '2026-10-02T20:05:00Z', profit: -90 },
    ],
    activities: [
      { id: 'amira-a1', kind: 'open', symbol: 'XAUUSD', side: 'buy', at: '2026-10-07T06:20:00Z', profit: null },
      { id: 'amira-a2', kind: 'close', symbol: 'US30', side: 'buy', at: '2026-10-06T19:10:00Z', profit: 420 },
      { id: 'amira-a3', kind: 'open', symbol: 'EURUSD', side: 'sell', at: '2026-10-06T14:05:00Z', profit: null },
      { id: 'amira-a4', kind: 'close', symbol: 'GBPUSD', side: 'sell', at: '2026-10-04T17:40:00Z', profit: 155 },
    ],
    chart: chartFor('Amira Hassan', 25000, [400, 180, -90, 520, 140, 260, 310], [
      [480, 20], [220, 40], [90, 180], [610, 30], [200, 60], [340, 40], [390, 20],
    ]),
  },
  {
    id: 'leo-berg',
    displayName: 'Leo Berg',
    username: 'leoberg',
    isYou: false,
    access: 'private',
    allowFollowing: true,
    roi: 12.6,
    winRate: 54,
    maxDrawdown: 11.4,
    closedTrades: 61,
    followerCount: 47,
    following: true,
    followsYou: true,
    previewBalance: 8150,
    openTrades: [
      { id: 'leo-o1', symbol: 'USDJPY', side: 'sell', openedAt: '2026-10-07T09:50:00Z', previewLot: 0.35, previewStopLoss: 153.8, previewTakeProfit: 151.9 },
    ],
    closedPerformance: [
      { id: 'leo-c1', symbol: 'EURUSD', side: 'buy', openedAt: '2026-10-06T06:30:00Z', closedAt: '2026-10-06T12:15:00Z', profit: 88 },
      { id: 'leo-c2', symbol: 'XAUUSD', side: 'sell', openedAt: '2026-10-03T11:00:00Z', closedAt: '2026-10-03T18:25:00Z', profit: -210 },
      { id: 'leo-c3', symbol: 'GBPJPY', side: 'buy', openedAt: '2026-10-01T08:40:00Z', closedAt: '2026-10-01T15:55:00Z', profit: 132 },
    ],
    activities: [
      { id: 'leo-a1', kind: 'open', symbol: 'USDJPY', side: 'sell', at: '2026-10-07T09:50:00Z', profit: null },
      { id: 'leo-a2', kind: 'close', symbol: 'EURUSD', side: 'buy', at: '2026-10-06T12:15:00Z', profit: 88 },
      { id: 'leo-a3', kind: 'close', symbol: 'XAUUSD', side: 'sell', at: '2026-10-03T18:25:00Z', profit: -210 },
    ],
    chart: chartFor('Leo Berg', 8000, [60, -140, 90, 40, -80, 110, 70], [
      [90, 30], [40, 180], [120, 20], [70, 30], [20, 100], [150, 40], [80, 10],
    ]),
  },
  {
    id: 'nora-okonkwo',
    displayName: 'Nora Okonkwo',
    username: 'nora',
    isYou: false,
    access: 'private',
    allowFollowing: true,
    roi: 27.8,
    winRate: 63,
    maxDrawdown: 6.4,
    closedTrades: 74,
    followerCount: 89,
    following: false,
    followsYou: true,
    previewBalance: 15720,
    openTrades: [
      { id: 'nora-o1', symbol: 'NAS100', side: 'buy', openedAt: '2026-10-07T13:05:00Z', previewLot: 0.5, previewStopLoss: 24780, previewTakeProfit: 25240 },
      { id: 'nora-o2', symbol: 'GBPUSD', side: 'buy', openedAt: '2026-10-07T07:25:00Z', previewLot: 0.4, previewStopLoss: 1.332, previewTakeProfit: 1.348 },
    ],
    closedPerformance: [
      { id: 'nora-c1', symbol: 'XAUUSD', side: 'buy', openedAt: '2026-10-06T09:10:00Z', closedAt: '2026-10-06T16:00:00Z', profit: 305 },
      { id: 'nora-c2', symbol: 'EURJPY', side: 'sell', openedAt: '2026-10-04T08:20:00Z', closedAt: '2026-10-04T14:45:00Z', profit: 96 },
      { id: 'nora-c3', symbol: 'US30', side: 'sell', openedAt: '2026-10-02T15:00:00Z', closedAt: '2026-10-02T21:30:00Z', profit: -48 },
    ],
    activities: [
      { id: 'nora-a1', kind: 'open', symbol: 'NAS100', side: 'buy', at: '2026-10-07T13:05:00Z', profit: null },
      { id: 'nora-a2', kind: 'open', symbol: 'GBPUSD', side: 'buy', at: '2026-10-07T07:25:00Z', profit: null },
      { id: 'nora-a3', kind: 'close', symbol: 'XAUUSD', side: 'buy', at: '2026-10-06T16:00:00Z', profit: 305 },
      { id: 'nora-a4', kind: 'close', symbol: 'EURJPY', side: 'sell', at: '2026-10-04T14:45:00Z', profit: 96 },
    ],
    chart: chartFor('Nora Okonkwo', 15000, [200, 90, 40, -70, 180, 220, 60], [
      [240, 10], [110, 20], [80, 40], [30, 100], [260, 20], [300, 40], [90, 30],
    ]),
  },
  {
    id: 'kenji-sato',
    displayName: 'Kenji Sato',
    username: 'kenji',
    isYou: false,
    access: 'open',
    allowFollowing: true,
    roi: 9.1,
    winRate: 57,
    maxDrawdown: 8.8,
    closedTrades: 38,
    followerCount: 21,
    following: false,
    followsYou: false,
    previewBalance: 12140,
    openTrades: [
      { id: 'kenji-o1', symbol: 'USDJPY', side: 'buy', openedAt: '2026-10-07T01:15:00Z', previewLot: 0.25, previewStopLoss: 151.7, previewTakeProfit: 154.1 },
    ],
    closedPerformance: [
      { id: 'kenji-c1', symbol: 'EURUSD', side: 'sell', openedAt: '2026-10-06T00:40:00Z', closedAt: '2026-10-06T08:10:00Z', profit: 64 },
      { id: 'kenji-c2', symbol: 'GBPJPY', side: 'sell', openedAt: '2026-10-03T02:20:00Z', closedAt: '2026-10-03T09:00:00Z', profit: -36 },
    ],
    activities: [
      { id: 'kenji-a1', kind: 'open', symbol: 'USDJPY', side: 'buy', at: '2026-10-07T01:15:00Z', profit: null },
      { id: 'kenji-a2', kind: 'close', symbol: 'EURUSD', side: 'sell', at: '2026-10-06T08:10:00Z', profit: 64 },
      { id: 'kenji-a3', kind: 'close', symbol: 'GBPJPY', side: 'sell', at: '2026-10-03T09:00:00Z', profit: -36 },
    ],
    chart: chartFor('Kenji Sato', 12000, [40, 20, -60, 80, 30, -20, 50], [
      [50, 10], [30, 10], [10, 70], [90, 10], [40, 10], [20, 40], [60, 10],
    ]),
  },
]

export function socialTraderById(id: string): SocialTrader | undefined {
  return SOCIAL_TRADERS.find(trader => trader.id === id)
}

/** Sample person asking to copy you. Shown on your page while your access is Private. */
export const SOCIAL_INCOMING_REQUESTS: Array<{ traderId: string }> = [
  { traderId: 'kenji-sato' },
]

/** Sample people who follow you. Stays fixed for the dashboard mock. */
export const SOCIAL_FOLLOWER_COUNT = SOCIAL_TRADERS.filter(trader => trader.followsYou).length

/** Sample traders you follow. Stays fixed for the dashboard mock. */
export const SOCIAL_FOLLOWING_COUNT = SOCIAL_TRADERS.filter(trader => trader.following).length
