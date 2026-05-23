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
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
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
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
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
    eyebrow: 'Une copie plus intelligente commence par de meilleurs outils',
    title:
      'Chaque fonction de TSCopier est conçue pour vous donner contrôle, clarté et des résultats mesurables.',
    cards: [
      {
        label: 'Vitesse d’exécution',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'Latence inférieure à 150 ms du parsing du signal à l’envoi courtier.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Plateforme cloud',
        metric: '100%',
        metricVariant: 'teal',
        description:
          '100 % cloud : pas de téléchargement, pas d’EA ni de VPS. Tout depuis le navigateur.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Échelle courtiers',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Jusqu’à 100 connexions MT5/MT4 par utilisateur.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Opérations',
        metric: '24/7',
        metricVariant: 'teal',
        description: 'Opérations 24/7 sans surveiller une machine locale.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Moteur de copie',
        metric: 'Avancé',
        metricVariant: 'amber',
        description:
          'Stratégie de copie avancée : modèles, filtres, backtest et règles par canal.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Fiabilité',
        metric: '99,99%',
        metricVariant: 'teal',
        description: '99,99 % de disponibilité pour copier quand le marché bouge.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Contrôles de risque',
        metric: 'Layering',
        metricVariant: 'neutral',
        description: 'Layering et clôture des entrées les plus défavorables sur signaux range et multi-TP.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Modes de trade',
        metric: 'Single & Range',
        metricVariant: 'neutral',
        description: 'Trading single et range avec règles de lot partagées.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Illimité',
        metricVariant: 'teal',
        description: 'Canaux et groupes Telegram illimités.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Backtest',
        metric: 'Replay',
        metricVariant: 'teal',
        description: 'Rejouez l’historique du canal avec vos règles avant de risquer du capital réel.',
        layout: 'short',
        icon: 'history',
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
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 mai, 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 mai, 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 mai, 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 mai, 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 mai, 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 mai, 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 mai, 19:48' },
        ],
      },
      news: {
        dayHeading: 'Jeudi 21 mai',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'Taux d’inflation YoY (avr.)',
            impact: 'high',
            actual: '1,40 %',
            forecast: '1,80 %',
            previous: '2,00 %',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'Décision de taux BoJ',
            impact: 'high',
            actual: '0,50 %',
            forecast: '0,50 %',
            previous: '0,25 %',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'Demandes initiales de chômage',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'PMI manufacturier S&P Global (mai)',
            impact: 'high',
            actual: '51,2',
            forecast: '50,8',
            previous: '50,3',
            actualTone: 'good',
          },
        ],
        articles: [
          {
            headline:
              'Or (XAUUSD), argent et platine — l’or recule alors que les traders s’inquiètent...',
            source: 'fxempire.com',
            relativeTime: 'il y a 10 h',
          },
          {
            headline: 'EUR/USD : les haussiers ont besoin d’un dollar plus faible pour franchir 1,10',
            source: 'fxstreet.com',
            relativeTime: 'il y a 12 h',
          },
          {
            headline: 'USD/JPY proche des sommets avec l’écart des taux avant le NFP',
            source: 'investing.com',
            relativeTime: 'il y a 14 h',
          },
        ],
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
  comparison: {
    eyebrow: 'Pourquoi les traders changent',
    title: 'Passez au niveau supérieur avec TSCopier',
    subtitle:
      'Copieurs Telegram classiques vs une plateforme cloud conçue pour la vitesse, la clarté et l’échelle.',
    otherLabel: 'Autres copieurs',
    tscopierLabel: 'TSCopier',
    cta: 'Commencer gratuitement',
    rows: [
      {
        aspect: 'Mise en route',
        other: 'Configuration difficile—beaucoup d’utilisateurs dépendent du support pour démarrer.',
        tscopier: 'Onboarding guidé dans le navigateur ; la plupart copient en environ deux minutes.',
      },
      {
        aspect: 'Tableau de bord',
        other: 'Interfaces encombrées qui noient l’essentiel.',
        tscopier: 'Un tableau de bord épuré centré sur les canaux, l’exécution et la santé des comptes.',
      },
      {
        aspect: 'Réglages',
        other: 'Trop d’options—facile de mal configurer et de perdre confiance.',
        tscopier: 'Valeurs par défaut intelligentes et contrôle fin par canal quand vous en avez besoin.',
      },
      {
        aspect: 'Infrastructure',
        other: 'VPS nécessaire pour faire tourner les EA 24h/24.',
        tscopier: '100 % cloud : pas de téléchargement, pas d’EA ni de VPS à maintenir.',
      },
      {
        aspect: 'Exécution',
        other: 'Exécution lente après réception du signal sur Telegram.',
        tscopier: 'Pipeline sous 150 ms du parsing à l’envoi courtier.',
      },
      {
        aspect: 'Limite de comptes',
        other: 'Souvent plafonné à 3–4 comptes liés.',
        tscopier: 'Jusqu’à 100 connexions MT4/MT5 par utilisateur.',
      },
      {
        aspect: 'Tarifs',
        other: 'Grilles complexes, options payantes et limites surprises.',
        tscopier: 'Offres claires avec les fonctions copieur essentielles incluses.',
      },
      {
        aspect: 'Gestion des trades',
        other: 'Intervention manuelle encore nécessaire pour modifications et clôtures.',
        tscopier: 'Entrées, couches, déplacements SL/TP et signaux de gestion automatisés.',
      },
      {
        aspect: 'Plateforme',
        other: 'Fonctions clés vendues en modules ou upgrades séparés.',
        tscopier: 'Copieur, backtest, journaux, actualités et calendrier dans un abonnement.',
      },
      {
        aspect: 'Backtest',
        other: 'Peu ou pas de replay réel de l’historique du canal avec vos règles.',
        tscopier: 'Backtest des signaux passés avec vos réglages réels avant le live.',
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
