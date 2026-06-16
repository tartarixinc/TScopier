import { testimonialsNl } from '../../testimonials/nl'
import type { LandingTranslations } from './types'

export const landingNl: LandingTranslations = {
  nav: {
    product: 'Product',
    features: 'Functies',
    pricing: 'Prijzen',
    faq: 'FAQ',
    docs: 'Docs',
    signIn: 'Inloggen',
    getStarted: 'Start gratis',
    dashboard: 'Dashboard',
    menuOpen: 'Menu openen',
    menuClose: 'Menu sluiten',
  },
  hero: {
    trustedBy: 'Al 30.000+ traders uit 156 landen zijn aangesloten',
    avatarAlts: ['TScopier-trader', 'TScopier-trader', 'TScopier-trader'],
    headline: 'Zet Telegram-signalen om in live trades,',
    headlineAccent: '100% op autopilot.',
    subheadline:
      'Kopieer trading-instructies van je signaalaanbieders naar MT4/MT5 in minder dan 2 minuten - geen complexe setup, geen EA en geen VPS nodig.',
    primaryCta: 'Probeer gratis',
    secondaryCta: 'Inloggen',
    imageAlt:
      'TScopier-dashboard met saldo, dagwinst, trade-resultaten en groeigrafieken van accounts',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'Over 5 gekoppelde accounts',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'vs gisteren +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 gewonnen · 4 verloren',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'Van 2 accounts',
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
          message: 'Kanaal Gold Signals Pro · listener verbonden',
          time: '22 mei, 09:36',
        },
        {
          message: 'BUY XAUUSD geparsed · 2 TP\'s uit Gold Signals Pro',
          time: '22 mei, 09:37',
        },
        {
          message: 'Order verstuurd naar MT5 · account #88291',
          time: '22 mei, 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 mei, 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 mei, 09:35',
        },
        {
          status: 'executed',
          channel: 'Indices Daily',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 mei, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    eyebrow: 'Slim kopieren begint met slimmere tools',
    title: 'Elke feature in TScopier is gebouwd voor controle, duidelijkheid en meetbaar resultaat.',
    cards: [
      {
        label: 'Executiesnelheid',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'Minder dan 150ms latency van signaal-parse tot broker-dispatch via onze cloud.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Cloudplatform',
        metric: '100%',
        metricVariant: 'teal',
        description:
          'Volledig cloud-based: geen download, geen EA en geen VPS. Beheer alles vanuit je browser.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Broker-schaal',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Tot 100 MT5/MT4-verbindingen per gebruiker over je gekoppelde accounts.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Operaties',
        metric: '24/7',
        metricVariant: 'teal',
        description: '24/7 actief - kopieer in elke sessie zonder lokale machine te bewaken.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Copy-engine',
        metric: 'Geavanceerd',
        metricVariant: 'teal',
        description:
          'Geavanceerde copy-strategie met templates, filters, backtest en regels per kanaal in een engine.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Betrouwbaarheid',
        metric: '99.99%',
        metricVariant: 'teal',
        description: '99.99% uptime zodat je copier online blijft wanneer de markt beweegt.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Risicocontroles',
        metric: 'Layering',
        metricVariant: 'neutral',
        description: 'Layering en close-worse-entries voor range-legs en signalen met meerdere TP\'s.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Trade-modi',
        metric: 'Single & Range',
        metricVariant: 'neutral',
        description: 'Single en range trading met gedeelde lot-regels en beheerinstructies.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Onbeperkt',
        metricVariant: 'teal',
        description: 'Onbeperkte Telegram-kanalen en groepen - alleen bronnen die jij vertrouwt.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Backtest',
        metric: 'Replay',
        metricVariant: 'teal',
        description: 'Speel kanaalhistorie af met jouw regels voordat je live kapitaal riskeert.',
        layout: 'short',
        icon: 'history',
      },
    ],
  },
  features: {
    eyebrow: 'Platformfuncties',
    title: 'Gebouwd voor serieuze signaalcopying',
    subtitle:
      'Alles wat je nodig hebt om Telegram-trades te automatiseren zonder controle te verliezen - met dezelfde flows als in de app.',
    showcases: [
      {
        eyebrow: 'Signaalcopier',
        title: 'Kopieer Telegram-signalen naar MT4 & MT5 met precisie',
        description:
          'Spiegel betrouwbare kanalen naar je brokeraccounts. TScopier parseert entries, take-profits, range-legs en management-instructies en voert uit met jouw lot-regels, multi-trade split en range-layering op elk gekoppeld account.',
        visual: 'copier',
      },
      {
        eyebrow: 'Kanaalcontrole',
        title: 'Filters en keyword-regels per kanaal',
        description:
          'Sta instructietypen per kanaal toe of blokkeer ze: closes, break-even moves, SL/TP-wijzigingen en meer. Alleen de signalen die jij wilt bereiken je broker.',
        visual: 'filters',
      },
      {
        eyebrow: 'Berichtbewerkingen',
        title: 'Signaalwijziging via bewerkte Telegram-berichten',
        description:
          'Wanneer een provider een Telegram-bericht bewerkt om stop loss of take-profits te wijzigen, pakt TScopier die revisie op en werkt je open basket bij op de broker - geen nieuwe entries, alleen gesynchroniseerde SL/TP op alle legs.',
        visual: 'signalEdit',
      },
      {
        eyebrow: 'Backtest',
        title: 'Speel kanaalhistorie af vóór je live gaat',
        description:
          'Run historische signalen tegen je handmatige instellingen en zie hoe de copier had gehandeld. Valideer parsing, lot-logica en uitkomsten zonder kapitaal te riskeren.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Copier-logs',
        title: 'Volledige transparantie op elke uitvoering',
        description:
          'Zie exact wat de worker heeft geparsed, gepland en verstuurd - met milliseconde-timestamps om kanalen te debuggen en fills realtime te verifiëren.',
        visual: 'logs',
      },
      {
        eyebrow: 'Markttools',
        title: 'Nieuws en economische kalender ingebouwd',
        description:
          'Volg high-impact events en geselecteerde marktkoppen in hetzelfde dashboard en pauzeer kopieren rond nieuws met blackout-regels.',
        visual: 'news',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Signaalkanaal',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 nieuwe signalen · zojuist',
        hubLabel: 'TScopier',
        mt4Label: 'MT4-account',
        mt4Meta: 'Kopieren · 0.10 lot-regels',
        mt5Label: 'MT5-account',
        mt5Meta: 'Kopieren · multi-TP split',
        pillLayering: 'Range-layering',
        pillLots: 'Lotgrootte',
        pillChannels: 'Live kanalen',
      },
      filters: {
        allowLabel: 'Toestaan',
        ignoreLabel: 'Negeren',
        rules: [
          {
            label: 'Volledige positie sluiten',
            example: 'bijv. "close", "exit trade", "flatten"',
            decision: 'allow',
          },
          {
            label: 'Break-even',
            example: 'bijv. "move SL to entry", "BE now"',
            decision: 'allow',
          },
          {
            label: 'TP aanpassen',
            example: 'bijv. "change TP to 4600"',
            decision: 'allow',
          },
          {
            label: 'Alle open trades sluiten',
            example: 'bijv. "close all", "flatten all"',
            decision: 'allow',
          },
          {
            label: 'Pending orders annuleren',
            example: 'bijv. "cancel limit", "delete pending"',
            decision: 'allow',
          },
        ],
      },
      signalEdit: {
        channelName: 'Gold Signals Pro',
        channelMeta: 'Telegram · bericht bewerkt',
        editedLabel: 'Bewerkt',
        messageBuy: 'BUY XAUUSD',
        beforeLabel: 'Eerder',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: 'Bijgewerkt',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 · TP2 4240',
        workerTitle: 'Kanaal-worker',
        workerMessage: 'SL/TP bijgewerkt op 7 open XAUUSD-legs (geen nieuwe trades geopend)',
        workerTime: 'Zojuist',
      },
      backtest: {
        resultsTitle: 'Backtest-resultaten',
        resultsSubtitle: 'XAUUSD · Kanaal',
        newRunLabel: 'Nieuwe run',
        totalPipsLabel: 'Totale pips',
        totalPips: '+544.0p',
        winRateLabel: 'Winratio',
        winRate: '67%',
        winLossLabel: 'W / V',
        winLoss: '16/8',
        signalsLabel: 'Signalen',
        signalsCount: '24',
        signalsListLabel: '24 signalen',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: 'Alle TP\'s',
            pips: '+62.0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL geraakt',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1u 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: 'Gedeeltelijk',
            pips: '+24.5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 mei, 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 mei, 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 mei, 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 mei, 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 mei, 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 mei, 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 mei, 19:48' },
        ],
      },
      news: {
        dayHeading: 'Donderdag 21 mei',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'Inflatie op jaarbasis (apr)',
            impact: 'high',
            actual: '1.40%',
            forecast: '1.80%',
            previous: '2.00%',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'BoJ rentebesluit',
            impact: 'high',
            actual: '0.50%',
            forecast: '0.50%',
            previous: '0.25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'Eerste werkloosheidsaanvragen',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'S&P Global Manufacturing PMI (mei)',
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
              'Goud (XAUUSD), zilver en platina verwachting - goud zakt terug nu traders bezorgd raken...',
            source: 'fxempire.com',
            relativeTime: '10u geleden',
          },
          {
            headline: 'EUR/USD: euro-bulls hebben een zwakkere dollar nodig om 1.10 te breken',
            source: 'fxstreet.com',
            relativeTime: '12u geleden',
          },
          {
            headline: 'USD/JPY blijft dicht bij highs terwijl renteverschillen oplopen richting NFP',
            source: 'investing.com',
            relativeTime: '14u geleden',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'Aan de slag',
    title: 'Hoe het werkt',
    subtitle: 'Van Telegram-kanaal naar broker-fill in drie stappen met dezelfde schermen als in de app.',
    items: [
      {
        title: 'Telegram koppelen',
        description:
          'Koppel je Telegram-account, kies signaalkanalen en verbind elk kanaal met de MT4/MT5-accounts die moeten kopieren.',
        visual: 'telegram',
      },
      {
        title: 'Je broker instellen',
        description:
          'Stel lotgrootte, TP-splits, range-regels en allow/ignore-filters per kanaal in voor elk gekoppeld account.',
        visual: 'configure',
      },
      {
        title: 'Signalen kopieren',
        description:
          'De kanaal-worker parseert elk bericht en de copier-logs tonen elke uitvoering in realtime op je dashboard.',
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
        rangeLabel: 'Range-layering',
        rangeValue: '50% · 3 pips',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'Sluitsignalen', decision: 'allow' },
          { label: 'SL / TP aanpassen', decision: 'allow' },
          { label: 'Break-even moves', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'BUY XAUUSD geparsed · 2 TP\'s uit Gold Signals Pro',
            time: '22 mei, 09:37',
          },
          {
            message: '0.10 lot verstuurd naar MT5 · account #88291',
            time: '22 mei, 09:37',
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
    title: 'Veelgestelde vragen',
    subtitle: 'Snelle antwoorden over setup, kopieren en wat TScopier anders maakt.',
    items: [
      {
        question: 'Moet ik een EA downloaden of een VPS draaien?',
        answer:
          'Nee. TScopier draait volledig in de cloud. Je logt in via je browser, koppelt Telegram en je MT4/MT5-accounts en de copier draait op onze infrastructuur - geen Expert Advisor-installatie of VPS-beheer nodig.',
      },
      {
        question: 'Welke platforms ondersteunt TScopier?',
        answer:
          'Je koppelt Telegram-signaalkanalen en kopieert naar MetaTrader 4- en MetaTrader 5-accounts. Koppel meerdere brokers en routeer elk kanaal naar de accounts die jij kiest.',
      },
      {
        question: 'Hoe snel worden trades gekopieerd?',
        answer:
          'Onze pipeline is gebouwd voor lage latency - meestal onder 150ms van signaal-parse tot broker-dispatch - zodat entries, wijzigingen en closes aankomen terwijl de prijs nog relevant is.',
      },
      {
        question: 'Hoeveel accounts kan ik koppelen?',
        answer:
          'Je kunt tot 100 MT4/MT5-verbindingen per gebruiker koppelen, afhankelijk van je plan. Elk Telegram-kanaal kan worden verbonden met een of meer brokeraccounts vanaf de Channels-pagina.',
      },
      {
        question: 'Leest TScopier mijn privéberichten op Telegram?',
        answer:
          'TScopier leest je persoonlijke chats niet. Telegram koppelen geeft alleen toegang tot kanalen en groepen waar je lid van bent, zodat de copier signalen kan ontvangen van bronnen die je toevoegt.',
      },
      {
        question: 'Kan ik een kanaal testen voordat ik live ga?',
        answer:
          'Ja. Gebruik Backtest om historische signalen van een kanaal af te spelen met je lot-regels, TP-splits, range-instellingen en filters, en bekijk de resultaten voordat je live copying inschakelt.',
      },
      {
        question: 'Ondersteunen jullie range-trades, layering en management-signalen?',
        answer:
          'Ja. TScopier verwerkt single- en range-entries, multi-TP lot-splitting, layering, close-worse-entries, break-even moves, partial profits en andere management-instructies - met allow/ignore-filters per kanaal.',
      },
      {
        question: 'Wat zit er in Basic versus Advanced?',
        answer:
          'Basic dekt core copying op één account met backtests en essentiële filters. Advanced voegt multi-account copying, range-layering, auto-management en onbeperkte Telegram-kanalen toe. Bekijk de prijzenpagina voor alle details.',
      },
    ],
  },
  reviews: {
    title: 'Wat traders zeggen',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsNl,
  },
  comparison: {
    eyebrow: 'Waarom traders overstappen',
    title: 'Ga een niveau hoger met TScopier',
    subtitle: 'Typische Telegram-copiers versus een cloudplatform gebouwd voor snelheid, duidelijkheid en schaal.',
    otherLabel: 'Andere copiers',
    tscopierLabel: 'TScopier',
    cta: 'Start gratis',
    rows: [
      {
        aspect: 'Setup',
        other: 'Moeilijk op te zetten - veel gebruikers hebben hulp nodig om live te gaan.',
        tscopier: 'Begeleide onboarding in de browser; de meeste traders kopieren binnen ongeveer twee minuten.',
      },
      {
        aspect: 'Dashboard',
        other: 'Drukke dashboards waarin belangrijke informatie wegvalt.',
        tscopier: 'Een schoon dashboard gericht op kanalen, uitvoering en accountgezondheid.',
      },
      {
        aspect: 'Configuratie',
        other: 'Te veel knoppen en toggles - makkelijk verkeerd in te stellen.',
        tscopier: 'Slimme defaults met diepgaande controle per kanaal wanneer je die nodig hebt.',
      },
      {
        aspect: 'Infrastructuur',
        other: 'VPS vereist om EA\'s 24/7 draaiend te houden.',
        tscopier: '100% cloud - geen download, geen EA en geen VPS om te onderhouden.',
      },
      {
        aspect: 'Uitvoering',
        other: 'Langzame trade-executie nadat het signaal op Telegram binnenkomt.',
        tscopier: 'Sub-150ms pipeline van parse tot broker-dispatch.',
      },
      {
        aspect: 'Accountlimieten',
        other: 'Vaak beperkt tot 3-4 gekoppelde accounts.',
        tscopier: 'Tot 100 MT4/MT5-verbindingen per gebruiker.',
      },
      {
        aspect: 'Prijzen',
        other: 'Complexe tiers, add-ons en onverwachte limieten.',
        tscopier: 'Eerlijke plannen met kernfeatures van de copier inbegrepen.',
      },
      {
        aspect: 'Tradebeheer',
        other: 'Handmatige interventie blijft nodig voor wijzigingen, partials en closes.',
        tscopier: 'Geautomatiseerde entries, layering, SL/TP-moves en management-signalen.',
      },
      {
        aspect: 'Platform',
        other: 'Belangrijke mogelijkheden worden als losse producten of upgrades verkocht.',
        tscopier: 'Copier, backtest, logs, nieuws en kalender in één abonnement.',
      },
      {
        aspect: 'Trade-merge',
        other:
          '"Gold buy now" opent trades, daarna opent "Gold buy now" met SL/TP opnieuw - je verdubbelt of corrigeert handmatig.',
        tscopier:
          '"Gold buy now" opent de trade. Als SL en TP in het volgende bericht komen, werken wij die trades bij - we openen Gold niet opnieuw.',
      },
      {
        aspect: 'Bewerkte berichten',
        other: 'Bewerkte Telegram-berichten worden genegeerd - je mist SL/TP-updates of corrigeert handmatig.',
        tscopier:
          'Signaalwijziging uit bewerkte berichten synchroniseert stop loss en take-profits over je open basket - zonder nieuwe trades.',
      },
      {
        aspect: 'Backtesting',
        other: 'Weinig tot geen echte replay van kanaalhistorie met jouw regels.',
        tscopier: 'Test historische signalen met jouw echte copy-instellingen voordat je live gaat.',
      },
    ],
  },
  pricing: {
    title: 'Kies je plan',
    subtitle: 'Start vandaag met het kopieren van signalen naar je trading-accounts.',
  },
  planComparison: {
    eyebrow: 'Vergelijk plannen',
    title: 'Vind de juiste match',
    subtitle: 'Bekijk per plan naast elkaar wat inbegrepen is.',
    basicColumn: 'Basic',
    advancedColumn: 'Advanced',
    customColumn: 'Maatwerk',
    rows: [
      {
        feature: 'Brokeraccounts',
        basic: '1',
        advanced: '5 (tot 100)',
        custom: 'Maatwerk',
      },
      {
        feature: 'Signaal-backtests',
        basic: '5 / maand',
        advanced: 'Onbeperkt',
        custom: 'Maatwerk',
      },
      {
        feature: 'Telegram-kanalen',
        basic: '5',
        advanced: 'Onbeperkt',
        custom: 'Maatwerk',
      },
      {
        feature: 'Take-profit niveaus',
        basic: '3 TP\'s',
        advanced: 'Onbeperkte TP\'s/SL\'s',
        custom: 'Maatwerk',
      },
      {
        feature: 'Range trading & layering',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Auto breakeven & management',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Kanaal keyword-volging',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Prioriteitssupport',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Dedicated onboarding',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Gratis proefperiode',
        basic: 'no',
        advanced: '10 dagen',
        custom: 'Maatwerk',
      },
      {
        feature: 'Vanafprijs',
        basic: '$9.99 / maand',
        advanced: '$39.99 / maand',
        custom: 'Contact opnemen',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'Pricing FAQ',
    title: 'Vragen over prijzen',
    subtitle: 'Uitleg over facturatie, proefperiodes en planwissels.',
    items: [
      {
        question: 'Is er een gratis proefperiode?',
        answer:
          'Advanced bevat een gratis proefperiode van 10 dagen zodra je abonneert. Basic wordt vanaf dag één gefactureerd tegen $9.99/maand (of $95.90/jaar met jaarlijkse facturatie). Je kunt het dashboard verkennen zonder abonnement, maar live copying vereist een actief plan.',
      },
      {
        question: 'Wat is het verschil tussen maandelijkse en jaarlijkse facturatie?',
        answer:
          'Jaarlijkse facturatie bespaart 20% ten opzichte van maandelijks betalen over een jaar. Basic gaat van $9.99/maand naar effectief $7.99/maand ($95.90/jaar). Advanced gaat van $39.99/maand naar effectief $31.99/maand ($383.90/jaar). Extra accounts op Advanced krijgen ook korting bij jaarlijkse facturatie.',
      },
      {
        question: 'Hoe werken extra accounts op Advanced?',
        answer:
          'Advanced bevat 5 demo/live brokeraccounts. Je kunt tot 95 extra accounts toevoegen voor $10/account/maand (of $96/account/jaar bij jaarlijkse facturatie), tot maximaal 100 gekoppelde accounts per gebruiker.',
      },
      {
        question: 'Kan ik later van plan wisselen?',
        answer:
          'Ja. Upgrade of downgrade op elk moment via Billing in je dashboard. Wijzigingen gaan in volgens je facturatiecyclus en Stripe regelt proratie bij planwissels.',
      },
      {
        question: 'Welke betaalmethoden accepteren jullie?',
        answer:
          'We accepteren de meeste credit- en debitcards via Stripe. Facturen en betaalgeschiedenis kun je downloaden vanaf je Billing-pagina.',
      },
      {
        question: 'Wanneer kies ik voor Custom?',
        answer:
          'Custom is voor prop firms, trading teams of high-volume operators die accountlimieten, facturatie of onboarding op maat nodig hebben. Neem contact op met sales en we stellen een passend plan samen.',
      },
      {
        question: 'Kan ik op elk moment opzeggen?',
        answer:
          'Ja. Zeg op via Billing of het Stripe customer portal. Je houdt toegang tot het einde van je huidige facturatieperiode. Er zijn geen langlopende contracten op Basic of Advanced.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} traders hebben vandaag gekocht',
    purchaseToast: 'Een trader uit {country} heeft zojuist een {plan}-abonnement gekocht.',
    timeAgoJustNow: 'Zojuist',
    timeAgoOneMinute: '1 minuut geleden',
  },
  pricingSnippet: {
    basic: 'Basic — $9.99/maand',
    advanced: 'Advanced — 10 dagen gratis, daarna $39.99/maand',
  },
  footer: {
    cta: {
      title: 'Klaar om signalen te kopieren zonder handmatig werk?',
      subtitle:
        'Koppel Telegram, verbind MT4 of MT5 en begin binnen enkele minuten met kopieren - zonder VPS of installatie.',
      primary: 'Probeer gratis',
      secondary: 'Inloggen',
    },
    tagline: 'Supersnelle Telegram-signaalcopier voor MetaTrader-accounts.',
    columns: {
      product: 'Product',
      resources: 'Resources',
      account: 'Account',
    },
    links: {
      overview: 'Overzicht',
      features: 'Functies',
      pricing: 'Prijzen',
      howItWorks: 'Hoe het werkt',
      faq: 'FAQ',
      docs: 'Documentatie',
      status: 'Systeemstatus',
      telegram: 'Telegram-support',
      riskDisclaimer: 'Risicodisclaimer',
      termsOfService: 'Servicevoorwaarden',
      privacyPolicy: 'Privacybeleid',
      cookiePolicy: 'Cookiebeleid',
      signIn: 'Inloggen',
      signUp: 'Account maken',
      openApp: 'Dashboard openen',
    },
    platforms: 'Werkt met',
    copyright: '© {year} Tartarix Inc. Alle rechten voorbehouden.',
    disclaimer:
      'Traden brengt risico met zich mee. TScopier is een copytool - geen financieel advies.',
  },
}
