import type { Locale } from '../../types'

export interface ProviderPageCopy {
  seoTitle: string
  hero: {
    eyebrow: string
    title: string
    description: string
    primaryCta: string
    secondaryCta: string
    note: string
    stats: readonly { value: string; label: string }[]
    visual: {
      sampleBadge: string
      monthlyEarnings: string
      activeCopiers: string
      vsLastMonth: string
      recentActivity: string
      newCopier: string
      copyRequest: string
      priceSet: string
      justNow: string
      minutesAgo: string
      /** Weekday initials for the chart, Monday first. */
      weekdays: readonly string[]
    }
  }
  steps: {
    eyebrow: string
    title: string
    description: string
    items: readonly { title: string; description: string }[]
  }
  calculator: {
    eyebrow: string
    title: string
    description: string
    copiers: string
    price: string
    perMonth: string
    perYear: string
    keep: string
    keepValue: string
    disclaimer: string
    cta: string
  }
  toolkit: {
    eyebrow: string
    title: string
    description: string
    pricing: { title: string; description: string; free: string; paid: string; unit: string }
    access: {
      title: string
      description: string
      anyone: string
      requests: string
      accept: string
      decline: string
      requested: string
    }
    profile: {
      title: string
      description: string
      roi: string
      winRate: string
      drawdown: string
      closedTrades: string
    }
    community: { title: string; description: string; followers: string; liveCopiers: string }
    automation: {
      title: string
      description: string
      yourTrade: string
      engine: string
      followerAccounts: string
    }
  }
  faq: {
    eyebrow: string
    title: string
    items: readonly { question: string; answer: string }[]
  }
  finalCta: {
    title: string
    description: string
    primaryCta: string
    traderLink: string
  }
  /** Teaser link on the traders landing page. */
  landingLink: string
}

export const providerPageEn: ProviderPageCopy = {
  seoTitle: 'UniCopier for signal providers',
  hero: {
    eyebrow: 'For signal providers',
    title: 'Turn your trading edge into recurring income.',
    description:
      'List your strategy on UniCopier, set your own monthly price and let traders copy your trades automatically. You keep 100% of what they pay you.',
    primaryCta: 'Become a provider',
    secondaryCta: 'See how it works',
    note: 'Set up in minutes · Keep 100% of your earnings',
    stats: [
      { value: '100%', label: 'of your earnings are yours' },
      { value: 'Your price', label: 'free or a monthly fee' },
      { value: 'Automatic', label: 'copying for every follower' },
      { value: 'Verified', label: 'public performance profile' },
    ],
    visual: {
      sampleBadge: 'Sample data',
      monthlyEarnings: 'Monthly earnings',
      activeCopiers: 'Active copiers',
      vsLastMonth: 'vs last month',
      recentActivity: 'Recent activity',
      newCopier: 'started copying you',
      copyRequest: 'requested to copy you',
      priceSet: 'Monthly price',
      justNow: 'Just now',
      minutesAgo: '{count} min ago',
      weekdays: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    },
  },
  steps: {
    eyebrow: 'How it works',
    title: 'From your first trade to your first subscriber',
    description: 'Four steps to a signal service that runs on its own.',
    items: [
      {
        title: 'Connect your account',
        description: 'Link the MT4, MT5 or cTrader account you already trade on.',
      },
      {
        title: 'Create your provider profile',
        description: 'Add your name and publish your verified performance to the social directory.',
      },
      {
        title: 'Set your price and access',
        description: 'Charge a monthly fee or copy for free, and choose who is allowed to copy you.',
      },
      {
        title: 'Get paid as traders copy',
        description: 'Every trade you place is copied to your subscribers automatically.',
      },
    ],
  },
  calculator: {
    eyebrow: 'Earnings estimator',
    title: 'See what your edge could earn',
    description:
      'Move the sliders to estimate your monthly income. You keep 100% of every subscription.',
    copiers: 'Copiers',
    price: 'Monthly price',
    perMonth: 'Per month',
    perYear: 'Per year',
    keep: 'You keep',
    keepValue: '100%',
    disclaimer: 'Illustrative estimate only. It is not a guarantee of earnings.',
    cta: 'Start earning',
  },
  toolkit: {
    eyebrow: 'Provider toolkit',
    title: 'Everything you need to run a signal service',
    description: 'Pricing, access, performance and community tools, built into the same app you trade from.',
    pricing: {
      title: 'Your price, your rules',
      description: 'Charge a monthly fee or let traders copy you for free. Change it whenever you like.',
      free: 'Free',
      paid: 'Paid',
      unit: '/Month',
    },
    access: {
      title: 'Control who copies you',
      description: 'Open your profile to everyone, or review each request and accept or decline.',
      anyone: 'Anyone can copy',
      requests: 'Requests required',
      accept: 'Accept',
      decline: 'Decline',
      requested: 'Requested to copy',
    },
    profile: {
      title: 'A verified track record',
      description: 'Followers see ROI, win rate, drawdown and closed trades, pulled from your real trading.',
      roi: 'ROI',
      winRate: 'Win rate',
      drawdown: 'Max drawdown',
      closedTrades: 'Closed trades',
    },
    community: {
      title: 'Know your community',
      description: 'See who follows and copies you, and watch your live copiers grow.',
      followers: 'Followers',
      liveCopiers: 'Live copiers',
    },
    automation: {
      title: 'Trade the way you always do',
      description:
        'Every trade on your connected account is mirrored to your subscribers, each with their own lot size and risk settings.',
      yourTrade: 'Your trade',
      engine: 'UniCopier',
      followerAccounts: 'Follower accounts',
    },
  },
  faq: {
    eyebrow: 'Provider FAQ',
    title: 'Questions from signal providers',
    items: [
      {
        question: 'Do I really keep 100% of the profit?',
        answer:
          'Yes. Whatever traders pay you for copying your trades is yours. UniCopier does not take a cut of your subscription income.',
      },
      {
        question: 'Can I offer my service for free?',
        answer:
          'Yes. You decide the price. Set a monthly fee, or let traders copy you for free to grow your following first.',
      },
      {
        question: 'Can I decide who copies me?',
        answer:
          'Yes. Keep your profile open so anyone can copy you, or require a request and accept or decline each trader yourself.',
      },
      {
        question: 'What do traders see on my profile?',
        answer:
          'Your display name, username, country and verified performance such as ROI, win rate, drawdown and closed trades. Your private account details stay private.',
      },
      {
        question: 'Which platforms can I trade on?',
        answer:
          'Connect the MT4, MT5 or cTrader account you already use. UniCopier copies your trades from there, so nothing changes about how you trade.',
      },
      {
        question: 'Do I need to be technical?',
        answer:
          'No. There is no server or code to manage. Connect your account, set your price and UniCopier handles the copying.',
      },
    ],
  },
  finalCta: {
    title: 'Ready to get paid for your trades?',
    description: 'Create your account, publish your profile and start building your community today.',
    primaryCta: 'Become a provider',
    traderLink: 'Want to copy traders instead?',
  },
  landingLink: 'Explore the provider page',
}

/** Locales without a translation fall back to English. */
const PROVIDER_PAGE_COPY: Partial<Record<Locale, ProviderPageCopy>> = {
  en: providerPageEn,
}

export function getProviderPageCopy(locale: Locale): ProviderPageCopy {
  return PROVIDER_PAGE_COPY[locale] ?? providerPageEn
}
