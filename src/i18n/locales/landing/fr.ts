import { testimonialsFr } from '../../testimonials/fr'
import type { LandingTranslations } from './types'

export const landingFr: LandingTranslations = {
  nav: {
    product: 'Produit',
    features: 'Fonctionnalités',
    pricing: 'Tarifs',
    faq: 'FAQ',
    docs: 'Docs',
    signIn: 'Se connecter',
    getStarted: 'Commencer',
    dashboard: 'Tableau de bord',
    menuOpen: 'Ouvrir le menu',
    menuClose: 'Fermer le menu',
  },
  hero: {
    trustedBy: 'Plus de 30 000 traders de 156 pays ont déjà rejoint',
    avatarAlts: ['Avatar de trader', 'Avatar de trader', 'Avatar de trader'],
    headline: 'Transformez les signaux Telegram en trades en direct,',
    headlineAccent: '100 % en autopilote.',
    subheadline:
      'Connectez votre compte MT4/MT5, choisissez vos canaux de signaux et laissez TSCopier exécuter entrées, couches et gestion — avec un contrôle total du risque et des filtres.',
    primaryCta: 'Essayez gratuitement',
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
      'Chaque fonction de TScopier est conçue pour vous donner contrôle, clarté et des résultats mesurables.',
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
          '100 % cloud : pas de téléchargement, pas d’EA sur votre terminal ni de VPS. Compatible avec toutes les prop firms, EA autorisés ou non.',
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
        metricVariant: 'teal',
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
        label: 'Multilingue',
        metric: 'Signaux',
        metricVariant: 'teal',
        description: 'Analyse achat, vente, SL et TP sur des canaux en anglais, espagnol, russe, polonais et plus.',
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
        eyebrow: 'Signaux multilingues',
        title: 'Prend en charge les signaux en plusieurs langues',
        description:
          'Copiez des canaux en anglais, espagnol, français, russe, polonais, japonais et plus encore. TSCopier reconnaît achat/vente, SL, TP et les consignes de gestion dans chaque langue, avec entraînement par canal pour le vocabulaire exact de votre fournisseur.',
        visual: 'multilingual',
      },
      {
        eyebrow: 'Contrôle par canal',
        title: 'Filtres et règles par mot-clé',
        description:
          'Autorisez ou bloquez les types d’instructions par canal — clôtures, break-even, ajustements SL/TP, etc. Seuls les signaux voulus atteignent le broker.',
        visual: 'filters',
      },
      {
        eyebrow: 'Messages modifiés',
        title: 'Modification de signal depuis les messages édités',
        description:
          'Quand un fournisseur modifie un message Telegram pour changer le stop ou les take-profits, TSCopier détecte la révision et met à jour votre panier ouvert chez le broker — pas de nouvelles entrées, seulement des SL/TP synchronisés sur chaque jambe.',
        visual: 'signalEdit',
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
      multilingual: {
        languagesBadge: '10+ langues',
        moreLanguages: 'Allemand, arabe, portugais, italien et plus',
        parsedLabel: 'Analysé',
        ribbonFlags: ['us', 'gb', 'es', 'fr', 'pl', 'ru', 'se', 'nl', 'jp'],
        signals: [
          {
            flagId: 'us',
            language: 'English',
            message: 'BUY XAUUSD now · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'es',
            language: 'Español',
            message: 'COMPRA XAUUSD ahora · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'fr',
            language: 'Français',
            message: 'ACHAT XAUUSD immédiat · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'ru',
            language: 'Русский',
            message: 'ПОКУПКА XAUUSD сейчас · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'ja',
            language: '日本語',
            message: 'XAUUSD 買い 成行 · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
        ],
      },
      signalEdit: {
        channelName: 'Gold Signals Pro',
        channelMeta: 'Telegram · message modifié',
        editedLabel: 'Modifié',
        messageBuy: 'ACHAT XAUUSD',
        beforeLabel: 'Avant',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: 'Mis à jour',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 · TP2 4240',
        workerTitle: 'Channel worker',
        workerMessage: 'SL/TP mis à jour sur 7 jambes XAUUSD ouvertes (aucun nouveau trade)',
        workerTime: 'À l’instant',
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
    eyebrow: 'Démarrage',
    title: 'Comment ça marche',
    subtitle: 'Du canal Telegram au broker en trois étapes — avec les mêmes écrans que dans l’app.',
    items: [
      {
        title: 'Connecter Telegram',
        description:
          'Liez votre compte Telegram, choisissez les canaux de signaux et reliez-les aux comptes MT4/MT5 qui copient.',
        visual: 'telegram',
      },
      {
        title: 'Configurer le broker',
        description:
          'Définissez le lot, la répartition des TPs, les règles de range et les filtres autoriser/ignorer par canal.',
        visual: 'configure',
      },
      {
        title: 'Copier les signaux',
        description:
          'Le channel worker analyse chaque message ; les journaux copieur affichent chaque exécution en direct.',
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
        lotSize: '0,10',
        rangeLabel: 'Couches en range',
        rangeValue: '50 % · 3 pips',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'Signaux de clôture', decision: 'allow' },
          { label: 'Modifier SL / TP', decision: 'allow' },
          { label: 'Passage au BE', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Analysé BUY XAUUSD · 2 TPs depuis Gold Signals Pro',
            time: '22 mai, 09:37',
          },
          {
            message: 'Envoyé 0,10 lot vers MT5 · compte #88291',
            time: '22 mai, 09:37',
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
    title: 'Questions fréquentes',
    subtitle: 'Réponses rapides sur la configuration, la copie et ce qui distingue TScopier.',
    items: [
      {
        question: 'Faut-il installer un EA ou un VPS ?',
        answer:
          'Non. TScopier est entièrement cloud. Vous vous connectez dans le navigateur, liez Telegram et vos comptes MT4/MT5, et le copieur tourne sur notre infrastructure—sans EA ni VPS à maintenir.',
      },
      {
        question: 'TScopier fonctionne-t-il avec les prop firms qui interdisent les EA ?',
        answer:
          'Oui. TScopier tourne entièrement dans le cloud—rien n’est installé sur votre terminal MT4/MT5. Vous pouvez copier des signaux sur tout compte prop firm, qu’elle autorise ou non les Expert Advisors.',
      },
      {
        question: 'Quelles plateformes TScopier prend-il en charge ?',
        answer:
          'Vous connectez des canaux de signaux Telegram et copiez vers MetaTrader 4 et 5. Liez plusieurs courtiers et routez chaque canal vers les comptes de votre choix.',
      },
      {
        question: 'À quelle vitesse les trades sont-ils copiés ?',
        answer:
          'Notre pipeline vise une faible latence—souvent sous 150 ms du parsing à l’envoi courtier—pour que entrées, modifications et clôtures arrivent tant que le prix reste pertinent.',
      },
      {
        question: 'Combien de comptes puis-je connecter ?',
        answer:
          'Jusqu’à 100 connexions MT4/MT5 par utilisateur selon votre forfait. Chaque canal Telegram peut être relié à un ou plusieurs comptes depuis la page Canaux.',
      },
      {
        question: 'TScopier lit-il mes messages Telegram privés ?',
        answer:
          'TScopier ne lit pas vos conversations personnelles. La connexion Telegram donne seulement accès aux canaux et groupes dont vous êtes membre pour recevoir les signaux que vous ajoutez.',
      },
      {
        question: 'Puis-je tester un canal avant le live ?',
        answer:
          'Oui. Utilisez le backtest pour rejouer les signaux passés avec vos règles de lot, TPs, range et filtres—puis examinez les résultats avant d’activer la copie live.',
      },
      {
        question: 'Prenez-vous en charge le range, le layering et la gestion ?',
        answer:
          'Oui. TSCopier gère entrées single et range, répartition multi-TP, layering, clôture des pires entrées, break-even, profits partiels et plus, avec filtres autoriser/ignorer par canal.',
      },
      {
        question: 'Que comprend Basic vs Advanced ?',
        answer:
          'Basic couvre la copie essentielle sur un compte avec backtests et filtres de base. Advanced ajoute multi-comptes, couches en range, auto-gestion et canaux illimités. Voir Tarifs pour le détail actuel.',
      },
    ],
  },
  reviews: {
    title: 'Ce que disent les traders',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsFr,
  },
  comparison: {
    eyebrow: 'Pourquoi les traders changent',
    title: 'Passez au niveau supérieur avec TScopier',
    subtitle:
      'Copieurs Telegram classiques vs une plateforme cloud conçue pour la vitesse, la clarté et l’échelle.',
    otherLabel: 'Autres copieurs',
    tscopierLabel: 'TScopier',
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
        aspect: 'Prop firms',
        other:
          'Beaucoup de copieurs reposent sur des Expert Advisors sur votre terminal—bloqués quand une prop firm interdit le trading automatisé.',
        tscopier:
          'Exécution cloud sans EA sur votre compte—compatible avec toutes les prop firms, EA autorisés ou non.',
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
        aspect: 'Fusion de trades',
        other:
          '« Gold buy now » ouvre des positions, puis « Gold buy now » avec SL/TP en ouvre d’autres — doublons ou corrections manuelles.',
        tscopier:
          '« Gold buy now » ouvre le trade. Quand le SL et le TP arrivent dans le message suivant, nous mettons à jour ces positions — nous n’ouvrons pas Gold une deuxième fois.',
      },
      {
        aspect: 'Messages modifiés',
        other:
          'Les messages Telegram modifiés sont ignorés — vous ratez les mises à jour SL/TP ou corrigez à la main.',
        tscopier:
          'Modification de signal depuis les messages édités : SL et TPs synchronisés sur le panier ouvert, sans nouvelles entrées.',
      },
      {
        aspect: 'Backtest',
        other: 'Peu ou pas de replay réel de l’historique du canal avec vos règles.',
        tscopier: 'Backtest des signaux passés avec vos réglages réels avant le live.',
      },
    ],
  },
  pricing: {
    title: 'Choisissez votre plan',
    subtitle: 'Commencez à copier des signaux vers vos comptes de trading aujourd\'hui.',
  },
  planComparison: {
    eyebrow: 'Comparer les plans',
    title: 'Trouvez le bon plan',
    subtitle: 'Comparaison côte à côte de ce que chaque plan inclut.',
    basicColumn: 'Basic',
    advancedColumn: 'Advanced',
    customColumn: 'Sur mesure',
    rows: [
      {
        feature: 'Comptes broker',
        basic: '1',
        advanced: '5 (jusqu\'à 100)',
        custom: 'Sur mesure',
      },
      {
        feature: 'Backtests de signaux',
        basic: '5 / mois',
        advanced: 'Illimités',
        custom: 'Sur mesure',
      },
      {
        feature: 'Canaux Telegram',
        basic: '5',
        advanced: 'Illimités',
        custom: 'Sur mesure',
      },
      {
        feature: 'Niveaux de take profit',
        basic: '3 TPs',
        advanced: 'TPs/SLs illimités',
        custom: 'Sur mesure',
      },
      {
        feature: 'Trading range et layering',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Breakeven et gestion auto',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Suivi par mots-clés',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Support prioritaire',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Onboarding dédié',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Essai gratuit',
        basic: 'no',
        advanced: '10 jours',
        custom: 'Sur mesure',
      },
      {
        feature: 'Prix de départ',
        basic: '9,99 $ / mois',
        advanced: '39,99 $ / mois',
        custom: 'Contactez-nous',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'FAQ tarifs',
    title: 'Questions sur les tarifs',
    subtitle: 'Facturation, essais et changements de plan expliqués.',
    items: [
      {
        question: 'Y a-t-il un essai gratuit ?',
        answer:
          'Advanced inclut un essai gratuit de 10 jours à l\'abonnement. Basic est facturé dès le premier jour à 9,99 $/mois (ou 95,90 $/an en facturation annuelle). Vous pouvez explorer le tableau de bord avant de vous abonner, mais la copie live nécessite un plan actif.',
      },
      {
        question: 'Quelle est la différence entre facturation mensuelle et annuelle ?',
        answer:
          'La facturation annuelle économise 20 % par rapport au paiement mensuel sur une année. Basic passe de 9,99 $/mois à 7,99 $/mois effectif (95,90 $/an). Advanced passe de 39,99 $/mois à 31,99 $/mois effectif (383,90 $/an). Les comptes supplémentaires sur Advanced sont aussi remisés en annuel.',
      },
      {
        question: 'Comment fonctionnent les comptes supplémentaires sur Advanced ?',
        answer:
          'Advanced inclut 5 comptes demo/live. Vous pouvez en ajouter jusqu\'à 95 de plus à 10 $/compte/mois (ou 96 $/compte/an en annuel), pour un maximum de 100 comptes connectés par utilisateur.',
      },
      {
        question: 'Puis-je changer de plan plus tard ?',
        answer:
          'Oui. Passez à un plan supérieur ou inférieur à tout moment depuis Facturation dans votre tableau de bord. Les changements s\'appliquent selon votre cycle de facturation et Stripe gère le prorata entre les plans.',
      },
      {
        question: 'Quels moyens de paiement acceptez-vous ?',
        answer:
          'Nous acceptons les principales cartes de crédit et débit via Stripe. Factures et historique de paiement sont disponibles sur votre page Facturation.',
      },
      {
        question: 'Quand choisir Sur mesure ?',
        answer:
          'Sur mesure est pour les prop firms, équipes de trading ou opérateurs à fort volume qui ont besoin de limites, facturation ou onboarding adaptés. Contactez les ventes et nous établirons un plan sur mesure.',
      },
      {
        question: 'Puis-je annuler à tout moment ?',
        answer:
          'Oui. Annulez depuis Facturation ou le portail client Stripe. Vous conservez l\'accès jusqu\'à la fin de votre période de facturation en cours. Pas de contrat long terme sur Basic ou Advanced.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} traders ont acheté aujourd\'hui',
    purchaseToast: 'Un trader de {country} vient de souscrire à l\'abonnement {plan}.',
    timeAgoJustNow: 'À l\'instant',
    timeAgoOneMinute: 'Il y a 1 minute',
  },
  pricingSnippet: {
    basic: 'Basic — 9,99 $/mois',
    advanced: 'Advanced — 10 jours gratuits, puis 39,99 $/mois',
  },
  footer: {
    cta: {
      title: 'Prêt à copier des signaux sans le travail manuel ?',
      subtitle:
        'Reliez Telegram, connectez MT4 ou MT5 et commencez à copier en quelques minutes — sans VPS ni installation.',
      primary: 'Essayez gratuitement',
      secondary: 'Se connecter',
    },
    tagline: 'Copieur de signaux Telegram ultra-rapide pour comptes MetaTrader.',
    columns: {
      product: 'Produit',
      resources: 'Ressources',
      account: 'Compte',
    },
    links: {
      overview: 'Aperçu',
      features: 'Fonctionnalités',
      pricing: 'Tarifs',
      howItWorks: 'Comment ça marche',
      faq: 'FAQ',
      docs: 'Documentation',
      status: 'État du système',
      telegram: 'Support Telegram',
      riskDisclaimer: 'Avertissement sur les risques',
      termsOfService: 'Conditions d’utilisation',
      privacyPolicy: 'Politique de confidentialité',
      cookiePolicy: 'Politique de cookies',
      signIn: 'Se connecter',
      signUp: 'Créer un compte',
      openApp: 'Ouvrir le tableau de bord',
    },
    platforms: 'Compatible avec',
    copyright: '© {year} Tartarix Inc. Tous droits réservés.',
    disclaimer:
      'Le trading comporte des risques. TScopier est un outil de copie — pas un conseil financier.',
  },
}
