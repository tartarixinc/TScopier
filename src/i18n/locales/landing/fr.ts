import type { LandingTranslations } from './types'

export const landingFr: LandingTranslations = {
  nav: {
    product: 'Produit',
    features: 'Fonctionnalités',
    pricing: 'Tarifs',
    signIn: 'Se connecter',
    getStarted: 'Commencer',
    menuOpen: 'Ouvrir le menu',
    menuClose: 'Fermer le menu',
  },
  hero: {
    trustedBy: 'Plébiscité par plus de 30 000 traders dans 156 pays',
    avatarAlts: ['Avatar de trader', 'Avatar de trader', 'Avatar de trader'],
    headline: 'Copieur de signaux Telegram ultra-rapide',
    headlineAccent: 'Propulsé par l’IA.',
    subheadline:
      'Connectez votre compte MT4/MT5, choisissez vos canaux de signaux et laissez TSCopier exécuter entrées, couches et gestion — avec un contrôle total du risque et des filtres.',
    primaryCta: 'Commencer gratuitement',
    secondaryCta: 'Se connecter',
    imageAlt:
      'Tableau de bord TSCopier avec solde, profit du jour, résultats des trades et graphiques de croissance',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,250.00',
          sub: 'Sur 5 comptes connectés',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'vs hier +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 gagnés · 4 perdus',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$126.40',
          sub: 'Sur 2 comptes',
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
          message: 'Canal Gold Signals Pro · écoute connectée',
          time: '22 mai, 09:36',
        },
        {
          message: 'Analysé BUY XAUUSD · 2 TPs depuis Gold Signals Pro',
          time: '22 mai, 09:37',
        },
        {
          message: 'Ordre envoyé vers MT5 · compte #88291',
          time: '22 mai, 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 mai, 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 mai, 09:35',
        },
        {
          status: 'executed',
          channel: 'Indices Daily',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 mai, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    title: 'Pourquoi choisir TSCopier ?',
    subtitle:
      'Trois raisons pour lesquelles les traders quittent la copie manuelle et les EA locaux pour un copieur cloud conçu pour la vitesse.',
    items: [
      {
        title: 'Exécution rapide',
        description:
          'Les signaux sont analysés et envoyés à votre broker en quelques secondes, pas en minutes. Notre worker cloud utilise un pipeline à faible latence pour que entrées, modifications et clôtures Telegram atteignent MT4/MT5 tant que le prix reste pertinent—avec des journaux copieur pour chaque action.',
      },
      {
        title: 'Aucun téléchargement',
        description:
          'TSCopier est 100 % cloud. Pas d’EA à installer, pas de VPS à louer ni de scripts terminal à mettre à jour après chaque build. Connectez-vous depuis le navigateur, liez votre compte et gérez vos canaux depuis un seul tableau de bord—vos réglages se synchronisent automatiquement.',
      },
      {
        title: 'Configuration en 2 minutes',
        description:
          'Créez votre compte, reliez Telegram et connectez MT4 ou MT5 en quelques étapes guidées. La plupart des traders copient leur premier canal en environ deux minutes—sans branchements complexes, erreurs de compilation ni VPS à configurer le week-end.',
      },
    ],
  },
  features: {
    eyebrow: 'Fonctionnalités',
    title: 'Conçu pour le copy trading sérieux',
    subtitle:
      'Tout ce qu’il faut pour automatiser Telegram sans perdre le contrôle — illustré avec les mêmes flux que dans l’app.',
    showcases: [
      {
        eyebrow: 'Copieur de signaux',
        title: 'Copiez les signaux Telegram vers MT4 et MT5 avec précision',
        description:
          'Reproduisez vos canaux de confiance sur vos comptes broker. TSCopier analyse entrées, TPs, couches de range et instructions de gestion, puis exécute avec vos règles de lot, multi-trade et couches sur chaque compte connecté.',
        visual: 'copier',
      },
      {
        eyebrow: 'Contrôle par canal',
        title: 'Filtres et règles par mot-clé',
        description:
          'Autorisez ou bloquez les types d’instructions par canal — clôtures, break-even, ajustements SL/TP, etc. Seuls les signaux voulus atteignent le broker.',
        visual: 'filters',
      },
      {
        eyebrow: 'Backtest',
        title: 'Rejouez l’historique avant le live',
        description:
          'Testez les signaux passés avec vos réglages manuels et voyez comment le copieur aurait tradé. Validez l’analyse et la logique sans risquer de capital.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Journaux copieur',
        title: 'Transparence totale sur chaque exécution',
        description:
          'Voyez ce que le worker a analysé, planifié et envoyé — horodatage à la milliseconde pour déboguer les canaux et vérifier les fills en direct.',
        visual: 'logs',
      },
      {
        eyebrow: 'Outils marché',
        title: 'Actualités et calendrier économique intégrés',
        description:
          'Suivez les événements à fort impact et les titres sélectionnés depuis le même tableau de bord, avec blackout news optionnel.',
        visual: 'news',
      },
      {
        eyebrow: 'Intégrations',
        title: 'Compatible avec vos plateformes actuelles',
        description:
          'Connectez des canaux Telegram et copiez vers MetaTrader sans EA local ni scripts VPS.',
        visual: 'integrations',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Canal de signaux',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 nouveaux signaux · à l’instant',
        hubLabel: 'TSCopier',
        mt4Label: 'Compte MT4',
        mt4Meta: 'Copie · règles 0.10 lot',
        mt5Label: 'Compte MT5',
        mt5Meta: 'Copie · multi-TP',
        pillLayering: 'Couches de range',
        pillLots: 'Taille de lot',
        pillChannels: 'Canaux live',
      },
      filters: {
        allowLabel: 'Autoriser',
        ignoreLabel: 'Ignorer',
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
        resultsTitle: 'Résultats du backtest',
        resultsSubtitle: 'XAUUSD · Canal',
        newRunLabel: 'Nouvelle analyse',
        totalPipsLabel: 'Pips totaux',
        totalPips: '+544.0p',
        winRateLabel: 'Taux de réussite',
        winRate: '67%',
        winLossLabel: 'G / P',
        winLoss: '16/8',
        signalsLabel: 'Signaux',
        signalsCount: '24',
        signalsListLabel: '24 signaux',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: 'Tous les TP',
            pips: '+62.0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL touché',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: 'Partiel',
            pips: '+24.5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        hubLabel: 'Journaux copieur',
        pillLatency: 'Trace latence',
        pillLive: 'Flux live',
        entries: [
          { stage: 'Analysé', message: 'BUY XAUUSD · 2 TPs · couche', latency: '42ms' },
          { stage: 'Envoyé', message: 'Ordre #88291 · MT5', latency: '128ms' },
          { stage: 'Exécuté', message: '0.10 lot @ 2,324.50', latency: '312ms' },
        ],
      },
      news: {
        calendarTitle: 'Calendrier économique',
        impactHigh: 'Élevé',
        impactMed: 'Moy.',
        pillCalendar: 'Blackout news',
        events: [
          { name: 'NFP États-Unis', time: 'Auj. · 13:30 UTC', impact: 'high' },
          { name: 'Décision BCE', time: 'Jeu. · 12:15 UTC', impact: 'high' },
          { name: 'IPC Royaume-Uni', time: 'Ven. · 07:00 UTC', impact: 'med' },
        ],
        headlines: [
          { label: 'L’or poursuit sa hausse' },
          { label: 'EUR/USD franchit 1.10' },
          { label: 'BTC dépasse $70k' },
        ],
      },
      integrations: {
        hubLabel: 'TSCopier',
        labels: { telegram: 'Telegram', mt4: 'MT4', mt5: 'MT5' },
      },
    },
  },
  steps: {
    title: 'Comment ça marche',
    subtitle: 'Du canal Telegram au broker en trois étapes.',
    items: [
      {
        title: 'Connecter Telegram',
        description: 'Liez les canaux de confiance. Seuls ceux cochés alimentent votre broker.',
      },
      {
        title: 'Configurer le broker',
        description: 'Lot, TPs, couches, filtres et auto-gestion par compte.',
      },
      {
        title: 'Copier les signaux',
        description: 'TSCopier parse, planifie et envoie les ordres — vous supervisez depuis le tableau de bord.',
      },
    ],
  },
  reviews: {
    title: 'Approuvé par des traders',
    trustpilotLabel: 'Trustpilot',
    items: [
      {
        quote:
          'TSCopier a réduit mon copiage manuel presque à zéro. Les signaux arrivent sur MT5 en quelques secondes.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Tableau de bord clair, analyse fiable et logs faciles à déboguer.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'Couches en range et fermeture des pires entrées — je copie les signaux l’esprit tranquille.',
        author: 'Eloise Laurent',
      },
    ],
  },
  pricing: {
    title: 'Tarifs simples',
    subtitle: 'Commencez avec Basic ou débloquez les stratégies avancées avec Advanced.',
    perMonth: '/mois',
    popular: 'Le plus populaire',
    viewPlans: 'Voir tous les forfaits',
    basic: {
      name: 'Basic',
      description: 'Un compte, mode single-trade, backtests et filtres essentiels.',
      priceLabel: '9,99 $',
      cta: 'Commencer avec Basic',
    },
    advanced: {
      name: 'Advanced',
      description: 'Multi-comptes, couches en range, auto-gestion, canaux illimités.',
      priceLabel: '39,99 $',
      cta: 'Essai 10 jours',
    },
  },
  footer: {
    copyright: '© {year} Tartarix Inc.',
    docs: 'Documentation',
    status: 'Statut',
    openApp: 'Ouvrir l’app',
  },
}
