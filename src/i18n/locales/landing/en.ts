import type { LandingTranslations } from './types'

export const landingEn: LandingTranslations = {
  nav: {
    product: 'Product',
    features: 'Features',
    pricing: 'Pricing',
    signIn: 'Sign in',
    getStarted: 'Get started',
    menuOpen: 'Open menu',
    menuClose: 'Close menu',
  },
  hero: {
    trustedBy: 'Trusted by 30,000+ Traders from 156 Countries',
    avatarAlts: ['TSCopier trader', 'TSCopier trader', 'TSCopier trader'],
    headline: 'Ultra-Fast Telegram Signal Copier',
    headlineAccent: 'Powered by AI.',
    subheadline:
      'Connect your MT4/MT5 account, pick signal channels, and let TSCopier execute entries, layering, and management — with full control over risk and filters.',
    primaryCta: 'Get started free',
    secondaryCta: 'Sign in',
    imageAlt:
      'TSCopier dashboard with balance, daily profit, trade outcomes, and account growth charts',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'Across 5 connected accounts',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'vs yesterday +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 won · 4 lost',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'From 2 accounts',
          valueTone: 'good',
        },
      ],
      overviewStats: [
        { key: 'activeSignalChannels', value: '4', showAdd: true },
        { key: 'openTrades', value: '16' },
        { key: 'tradingAccountsConnected', value: '3', showAdd: true },
        { key: 'tradesCopiedToday', value: '3' },
      ],
      channelWorkerLogs: [
        {
          message: 'Channel Gold Signals Pro · listener connected',
          time: 'May 22, 09:36 AM',
        },
        {
          message: 'Parsed BUY XAUUSD · 2 TPs from Gold Signals Pro',
          time: 'May 22, 09:37 AM',
        },
        {
          message: 'Dispatched order to MT5 · account #88291',
          time: 'May 22, 09:37 AM',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: 'May 22, 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: 'May 22, 09:35',
        },
        {
          status: 'executed',
          channel: 'Indices Daily',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: 'May 22, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    title: 'Why Choose TSCopier?',
    subtitle:
      'Three reasons traders move off manual copying and local EAs—and stay on a cloud copier built for speed.',
    items: [
      {
        title: 'Fast Execution',
        description:
          'Signals are parsed and routed to your broker in seconds, not minutes. Our cloud worker uses a low-latency pipeline so entries, modifications, and closes from Telegram reach MT4/MT5 while price is still relevant—plus copier logs show exactly when each action ran.',
      },
      {
        title: 'No Download Needed',
        description:
          'TSCopier is 100% cloud-based. No EA to install, no VPS to rent, and no terminal scripts to update after every build. Sign in from any browser, connect your account, and manage channels from one dashboard—your settings sync automatically.',
      },
      {
        title: 'Setup in 2 Minutes',
        description:
          'Create your account, link Telegram, and connect MT4 or MT5 with guided steps. Most traders are ready to copy their first channel in about two minutes—no wiring experts, compile errors, or weekend VPS setup.',
      },
    ],
  },
  features: {
    eyebrow: 'Platform features',
    title: 'Built for serious signal copying',
    subtitle:
      'Everything you need to automate Telegram trades without giving up control—illustrated with the same flows you use in the app.',
    showcases: [
      {
        eyebrow: 'Signal copier',
        title: 'Copy Telegram signals to MT4 & MT5 with precision',
        description:
          'Mirror trusted channels into your broker accounts. TSCopier parses entries, take-profits, range legs, and management instructions—then executes with your lot rules, multi-trade splitting, and range layering on every connected account.',
        visual: 'copier',
      },
      {
        eyebrow: 'Channel control',
        title: 'Per-channel filters and keyword rules',
        description:
          'Allow or block instruction types per channel—closes, break-even moves, SL/TP adjustments, and more. Only the signals you want reach your broker.',
        visual: 'filters',
      },
      {
        eyebrow: 'Backtest',
        title: 'Replay channel history before going live',
        description:
          'Run past signals against your manual settings and see how the copier would have traded. Validate parsing, lot logic, and outcomes without risking capital.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Copier logs',
        title: 'Full transparency on every execution',
        description:
          'See exactly what the worker parsed, planned, and sent—with millisecond timestamps so you can debug channels and verify fills in real time.',
        visual: 'logs',
      },
      {
        eyebrow: 'Market tools',
        title: 'News and economic calendar built in',
        description:
          'Track high-impact events and curated market headlines from the same dashboard—optionally pause copying around news with blackout rules.',
        visual: 'news',
      },
      {
        eyebrow: 'Integrations',
        title: 'Works with the platforms you already use',
        description:
          'Connect Telegram signal channels and copy to MetaTrader accounts you manage today—no local EA installs or VPS scripts required.',
        visual: 'integrations',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Signal channel',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 new signals · just now',
        hubLabel: 'TSCopier',
        mt4Label: 'MT4 account',
        mt4Meta: 'Copying · 0.10 lot rules',
        mt5Label: 'MT5 account',
        mt5Meta: 'Copying · multi-TP split',
        pillLayering: 'Range layering',
        pillLots: 'Lot sizing',
        pillChannels: 'Live channels',
      },
      filters: {
        allowLabel: 'Allow',
        ignoreLabel: 'Ignore',
        rules: [
          {
            label: 'Close full position',
            example: 'e.g. "close", "exit trade", "flatten"',
            decision: 'allow',
          },
          {
            label: 'Break-even',
            example: 'e.g. "move SL to entry", "BE now"',
            decision: 'allow',
          },
          {
            label: 'Adjust TP',
            example: 'e.g. "change TP to 4600"',
            decision: 'allow',
          },
          {
            label: 'Close all open trades',
            example: 'e.g. "close all", "flatten all"',
            decision: 'allow',
          },
          {
            label: 'Cancel pending orders',
            example: 'e.g. "cancel limit", "delete pending"',
            decision: 'allow',
          },
        ],
      },
      backtest: {
        resultsTitle: 'Backtest results',
        resultsSubtitle: 'XAUUSD · Channel',
        newRunLabel: 'New run',
        totalPipsLabel: 'Total pips',
        totalPips: '+544.0p',
        winRateLabel: 'Win rate',
        winRate: '67%',
        winLossLabel: 'W / L',
        winLoss: '16/8',
        signalsLabel: 'Signals',
        signalsCount: '24',
        signalsListLabel: '24 signals',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: 'All TPs',
            pips: '+62.0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL Hit',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: 'Partial',
            pips: '+24.5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: 'May 22, 07:50 PM' },
          { symbol: 'XAUUSD', type: 'sell', time: 'May 22, 07:50 PM' },
          { symbol: 'XAUUSD', type: 'breakeven', time: 'May 22, 07:50 PM' },
          { symbol: 'XAUUSD', type: 'buy', time: 'May 22, 07:49 PM' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: 'May 22, 07:49 PM' },
          { symbol: 'XAUUSD', type: 'modify', time: 'May 22, 07:48 PM' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: 'May 22, 07:48 PM' },
        ],
      },
      news: {
        calendarTitle: 'Economic calendar',
        impactHigh: 'High',
        impactMed: 'Med',
        pillCalendar: 'News blackout',
        events: [
          { name: 'US Non-Farm Payrolls', time: 'Today · 13:30 UTC', impact: 'high' },
          { name: 'ECB Rate Decision', time: 'Thu · 12:15 UTC', impact: 'high' },
          { name: 'UK CPI', time: 'Fri · 07:00 UTC', impact: 'med' },
        ],
        headlines: [
          { label: 'Gold extends rally' },
          { label: 'EUR/USD breaks 1.10' },
          { label: 'BTC clears $70k' },
        ],
      },
      integrations: {
        hubLabel: 'TSCopier',
        labels: {
          telegram: 'Telegram',
          mt4: 'MT4',
          mt5: 'MT5',
        },
      },
    },
  },
  steps: {
    title: 'How it works',
    subtitle: 'From Telegram channel to broker fill in three steps.',
    items: [
      {
        title: 'Connect Telegram',
        description: 'Link the channels you trust. Only checked channels feed your broker.',
      },
      {
        title: 'Configure your broker',
        description: 'Set lot size, TPs, range layering, filters, and auto-management per account.',
      },
      {
        title: 'Copy signals',
        description: 'TSCopier parses, plans, and sends orders — you monitor from the dashboard.',
      },
    ],
  },
  reviews: {
    title: 'Trusted by traders',
    trustpilotLabel: 'Trustpilot',
    items: [
      {
        quote:
          'TSCopier cut my manual copying time to almost zero. Signals land on my MT5 account within seconds.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Clean dashboard, reliable parsing, and the copier logs make debugging easy.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'The range and layer trading plus worse-entries closing — I copy signals with peace of mind.',
        author: 'Eloise Laurent',
      },
    ],
  },
  pricing: {
    title: 'Simple pricing',
    subtitle: 'Start with Basic or unlock advanced strategies on Advanced.',
    perMonth: '/mo',
    popular: 'Most popular',
    viewPlans: 'View all plans',
    basic: {
      name: 'Basic',
      description: 'One account, single-trade mode, backtests, and core filters.',
      priceLabel: '$9.99',
      cta: 'Start with Basic',
    },
    advanced: {
      name: 'Advanced',
      description: 'Multi accounts, range layering, auto-management, unlimited channels.',
      priceLabel: '$39.99',
      cta: 'Start 10-day trial',
    },
  },
  footer: {
    copyright: '© {year} Tartarix Inc.',
    docs: 'Documentation',
    status: 'Status',
    openApp: 'Open app',
  },
}
