import { testimonialsEn } from '../../testimonials/en'
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
    trustedBy: '30,000+ Traders from 156 Countries Already Joined',
    avatarAlts: ['TSCopier trader', 'TSCopier trader', 'TSCopier trader'],
    headline: 'Ultra-Fast Telegram Signal Copier',
    headlineAccent: 'Powered by AI.',
    subheadline:
      'Connect your MT4/MT5 account, pick signal channels, and let TSCopier execute entries, layering, and management — with full control over risk and filters.',
    primaryCta: 'Try it for free',
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
    eyebrow: 'Smarter copying starts with smarter tools',
    title:
      'Every feature in TSCopier is built to give you control, clarity, and measurable results.',
    cards: [
      {
        label: 'Execution speed',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'Sub-150ms latency from signal parse to broker dispatch on our cloud pipeline.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Cloud platform',
        metric: '100%',
        metricVariant: 'teal',
        description:
          '100% cloud based—no download, no EA, and no VPS needed. Manage everything from your browser.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Broker scale',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Up to 100 MT5/MT4 connections per user across your linked accounts.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Operations',
        metric: '24/7',
        metricVariant: 'teal',
        description: '24/7 operations—copy through every session without babysitting a local machine.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Copy engine',
        metric: 'Advanced',
        metricVariant: 'amber',
        description:
          'Advanced copy strategy—templates, filters, backtest, and per-channel rules in one engine.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Reliability',
        metric: '99.99%',
        metricVariant: 'teal',
        description: '99.99% uptime so your copier stays online when markets move.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Risk controls',
        metric: 'Layering',
        metricVariant: 'neutral',
        description: 'Layering and close worse entries for range legs and multi-TP signals.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Trade modes',
        metric: 'Single & Range',
        metricVariant: 'neutral',
        description: 'Single and range trading with shared lot rules and management instructions.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Unlimited',
        metricVariant: 'teal',
        description: 'Unlimited Telegram channels and groups—only the sources you trust.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Backtest',
        metric: 'Replay',
        metricVariant: 'teal',
        description: 'Replay channel history on your rules before risking live capital.',
        layout: 'short',
        icon: 'history',
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
        dayHeading: 'Thursday, May 21',
        events: [
          {
            time: '01:00 AM',
            currency: 'JPY',
            name: 'Inflation Rate YoY (Apr)',
            impact: 'high',
            actual: '1.40%',
            forecast: '1.80%',
            previous: '2.00%',
            actualTone: 'bad',
          },
          {
            time: '01:30 AM',
            currency: 'JPY',
            name: 'BoJ Interest Rate Decision',
            impact: 'high',
            actual: '0.50%',
            forecast: '0.50%',
            previous: '0.25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30 AM',
            currency: 'USD',
            name: 'Initial Jobless Claims',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30 AM',
            currency: 'GBP',
            name: 'S&P Global Manufacturing PMI (May)',
            impact: 'high',
            actual: '51.2',
            forecast: '50.8',
            previous: '50.3',
            actualTone: 'good',
          },
        ],
        articles: [
          {
            headline:
              'Gold (XAUUSD), Silver, Platinum Forecasts – Gold Pulls Back As Traders Worry Abo...',
            source: 'fxempire.com',
            relativeTime: '10h ago',
          },
          {
            headline: 'EUR/USD: Euro bulls need a softer dollar to break 1.10 resistance',
            source: 'fxstreet.com',
            relativeTime: '12h ago',
          },
          {
            headline: 'USD/JPY holds near highs as yield spreads widen ahead of NFP',
            source: 'investing.com',
            relativeTime: '14h ago',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'Get started',
    title: 'How it works',
    subtitle: 'From Telegram channel to broker fill in three steps—using the same screens you get in the app.',
    items: [
      {
        title: 'Connect Telegram',
        description:
          'Link your Telegram account, pick signal channels, and connect each channel to the MT4/MT5 accounts that should copy it.',
        visual: 'telegram',
      },
      {
        title: 'Configure your broker',
        description:
          'Set lot size, TP splits, range rules, and per-channel allow/ignore filters for every linked account.',
        visual: 'configure',
      },
      {
        title: 'Copy signals',
        description:
          'The channel worker parses each message; copier logs show every execution in real time on your dashboard.',
        visual: 'copy',
      },
    ],
    visuals: {
      telegram: {
        channels: [
          {
            name: 'Gold Signals Pro',
            username: 'goldsignalspro',
            active: true,
            brokers: ['MT5 · #88291'],
          },
          {
            name: 'FX Scalper VIP',
            username: 'fxscalpervip',
            active: true,
            brokers: ['MT4 · #44102'],
          },
        ],
      },
      configure: {
        accountName: 'IC Markets · MT5',
        login: 'Login #88291',
        lotSize: '0.10',
        rangeLabel: 'Range layering',
        rangeValue: '50% · 3 pips',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'Close signals', decision: 'allow' },
          { label: 'Modify SL / TP', decision: 'allow' },
          { label: 'Breakeven moves', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Parsed BUY XAUUSD · 2 TPs from Gold Signals Pro',
            time: 'May 22, 09:37 AM',
          },
          {
            message: 'Dispatched 0.10 lot to MT5 · account #88291',
            time: 'May 22, 09:37 AM',
          },
        ],
        logRows: [
          { symbol: 'XAUUSD', type: 'buy', time: '09:37' },
          { symbol: 'XAUUSD', type: 'sell', time: '09:35' },
        ],
      },
    },
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Frequently asked questions',
    subtitle: 'Quick answers about setup, copying, and what makes TSCopier different.',
    items: [
      {
        question: 'Do I need to download an EA or run a VPS?',
        answer:
          'No. TSCopier is fully cloud-based. You sign in from your browser, connect Telegram and your MT4/MT5 accounts, and the copier runs on our infrastructure—no Expert Advisor installs or VPS to maintain.',
      },
      {
        question: 'Which platforms does TSCopier support?',
        answer:
          'You connect Telegram signal channels and copy to MetaTrader 4 and MetaTrader 5 accounts. Link multiple brokers and route each channel to the accounts you choose.',
      },
      {
        question: 'How fast are trades copied?',
        answer:
          'Our pipeline is built for low latency—typically under 150ms from signal parse to broker dispatch—so entries, modifications, and closes reach your terminal while price is still relevant.',
      },
      {
        question: 'How many accounts can I connect?',
        answer:
          'You can link up to 100 MT4/MT5 connections per user, depending on your plan. Each Telegram channel can be connected to one or more broker accounts from the Channels page.',
      },
      {
        question: 'Does TSCopier read my private Telegram messages?',
        answer:
          'TSCopier does not read your personal chats. Connecting Telegram only grants access to channels and groups you are a member of so the copier can receive signal messages from sources you add.',
      },
      {
        question: 'Can I test a channel before going live?',
        answer:
          'Yes. Use Backtest to replay past signals from a channel against your lot rules, TP splits, range settings, and filters—then review results before enabling live copying.',
      },
      {
        question: 'Do you support range trades, layering, and management signals?',
        answer:
          'Yes. TSCopier handles single and range entries, multi-TP lot splitting, layering, close-worse-entries, break-even moves, partial profits, and other management instructions—with per-channel allow/ignore filters.',
      },
      {
        question: 'What is included in Basic vs Advanced?',
        answer:
          'Basic covers core copying on one account with backtests and essential filters. Advanced adds multi-account copying, range layering, auto-management features, and unlimited Telegram channels. See Pricing for current plan details.',
      },
    ],
  },
  reviews: {
    title: 'What traders are saying',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsEn,
  },
  comparison: {
    eyebrow: 'Why traders switch',
    title: 'Level up with TSCopier',
    subtitle: 'Typical Telegram copiers vs a cloud platform built for speed, clarity, and scale.',
    otherLabel: 'Other copiers',
    tscopierLabel: 'TSCopier',
    cta: 'Start free',
    rows: [
      {
        aspect: 'Setup',
        other: 'Hard to set up—many users need hands-on support just to go live.',
        tscopier: 'Guided onboarding in the browser; most traders are copying in about two minutes.',
      },
      {
        aspect: 'Dashboard',
        other: 'Cluttered, crowded dashboards that bury what matters.',
        tscopier: 'A clean dashboard focused on channels, execution, and account health.',
      },
      {
        aspect: 'Configuration',
        other: 'Too many knobs and toggles—easy to misconfigure and lose confidence.',
        tscopier: 'Smart defaults with deep per-channel control when you actually need it.',
      },
      {
        aspect: 'Infrastructure',
        other: 'VPS required to keep EAs running around the clock.',
        tscopier: '100% cloud—no download, no EA, and no VPS to maintain.',
      },
      {
        aspect: 'Execution',
        other: 'Slow trade execution after the signal hits Telegram.',
        tscopier: 'Sub-150ms pipeline from parse to broker dispatch.',
      },
      {
        aspect: 'Account limits',
        other: 'Often capped at 3–4 linked accounts.',
        tscopier: 'Up to 100 MT4/MT5 connections per user.',
      },
      {
        aspect: 'Pricing',
        other: 'Complex tiers, add-ons, and surprise limits.',
        tscopier: 'Straightforward plans with core copier features included.',
      },
      {
        aspect: 'Trade management',
        other: 'Manual intervention still needed for modifies, partials, and closes.',
        tscopier: 'Automated entries, layering, SL/TP moves, and management signals.',
      },
      {
        aspect: 'Platform',
        other: 'Key capabilities sold as separate products or upgrades.',
        tscopier: 'Copier, backtest, logs, news, and calendar in one subscription.',
      },
      {
        aspect: 'Backtesting',
        other: 'Little or no real replay of channel history on your rules.',
        tscopier: 'Backtest past signals against your actual copy settings before going live.',
      },
    ],
  },
  pricing: {
    title: 'Choose your plan',
    subtitle: 'Start copying signals to your trading accounts today.',
  },
  pricingSnippet: {
    basic: 'Basic — $9.99/month',
    advanced: 'Advanced — 10 days free, then $39.99/month',
  },
  footer: {
    cta: {
      title: 'Ready to copy signals without the manual work?',
      subtitle:
        'Link Telegram, connect MT4 or MT5, and start copying in minutes — no VPS, no install.',
      primary: 'Try it for free',
      secondary: 'Sign in',
    },
    tagline: 'Ultra-fast Telegram signal copier for MetaTrader accounts.',
    columns: {
      product: 'Product',
      resources: 'Resources',
      account: 'Account',
    },
    links: {
      overview: 'Overview',
      features: 'Features',
      pricing: 'Pricing',
      howItWorks: 'How it works',
      faq: 'FAQ',
      docs: 'Documentation',
      status: 'System status',
      telegram: 'Telegram support',
      signIn: 'Sign in',
      signUp: 'Create account',
      openApp: 'Open dashboard',
    },
    platforms: 'Works with',
    copyright: '© {year} Tartarix Inc. All rights reserved.',
    disclaimer:
      'Trading involves risk. TSCopier is a copy tool — not financial advice.',
  },
}
