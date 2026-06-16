import { testimonialsSv } from '../../testimonials/sv'
import type { LandingTranslations } from './types'

export const landingSv: LandingTranslations = {
  nav: {
    product: 'Produkt',
    features: 'Drag',
    pricing: 'Prissättning',
    faq: 'FAQ',
    docs: 'Dokument',
    signIn: 'Logga in',
    getStarted: 'Kom igång',
    dashboard: 'Instrumentbräda',
    menuOpen: 'Öppna menyn',
    menuClose: 'Stäng menyn',
  },
  hero: {
    trustedBy: '30 000+ handlare från 156 länder har redan gått med',
    avatarAlts: ['TScopier handlare', 'TScopier handlare', 'TScopier handlare'],
    headline: 'Förvandla Telegram-signaler till liveaffärer,',
    headlineAccent: '100 % på autopilot.',
    subheadline:
      'Kopiera handelsinstruktioner från dina signalleverantörer till din MT4/MT5 på mindre än 2 minuter - Inga komplicerade inställningar, ingen EA och ingen VPS krävs.',
    primaryCta: 'Prova det gratis',
    secondaryCta: 'Logga in',
    imageAlt:
      'TScopier instrumentpanel med balans, daglig vinst, handelsresultat och kontotillväxtdiagram',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'På 5 anslutna konton',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'jämfört med igår +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 vann Â· 4 förlorade',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'Från 2 konton',
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
          message: 'Channel Gold Signals Pro · lyssnare ansluten',
          time: '22 maj, 09:36',
        },
        {
          message: 'Parsed KÖP XAUUSD Â· 2 TPs från Gold Signals Pro',
          time: '22 maj, 09:37',
        },
        {
          message: 'Skickade beställningen till MT5 Â· konto #88291',
          time: '22 maj, 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 maj, 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 maj, 09:35',
        },
        {
          status: 'executed',
          channel: 'Index dagligen',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 maj, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    eyebrow: 'Smartare kopiering börjar med smartare verktyg',
    title:
      'Varje funktion i TScopier är byggd för att ge dig kontroll, tydlighet och mätbara resultat.',
    cards: [
      {
        label: 'Utförandehastighet',
        metric: '<150 ms',
        metricVariant: 'teal',
        description: 'Latens under 150 ms från signalanalys till mäklarutskick på vår molnpipeline.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Molnplattform',
        metric: '100 %',
        metricVariant: 'teal',
        description:
          '100 % molnbaserad – ingen nedladdning, ingen EA på din terminal och ingen VPS. Fungerar med alla prop firms, med eller utan tillåten EA.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Mäklare skala',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Upp till 100 MT5/MT4 anslutningar per användare över dina länkade konton.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Operationer',
        metric: '24/7',
        metricVariant: 'teal',
        description: '24/7 operationer - kopiera igenom varje session utan att vara barnvakt på en lokal maskin.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Kopiera motor',
        metric: 'Avancerad',
        metricVariant: 'teal',
        description:
          'Avancerad kopieringsstrategi – mallar, filter, backtest och regler per kanal i en motor.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Pålitlighet',
        metric: '99,99 %',
        metricVariant: 'teal',
        description: '99,99 % drifttid så att din kopiator förblir online när marknaderna rör sig.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Riskkontroller',
        metric: 'Skiktning',
        metricVariant: 'neutral',
        description: 'Lagring och stäng sämre ingångar för avståndsben och multi-TP-signaler.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Handelssätt',
        metric: 'Singel & Range',
        metricVariant: 'neutral',
        description: 'Singel- och intervallhandel med delade lotsregler och förvaltningsinstruktioner.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Obegränsat',
        metricVariant: 'teal',
        description: 'Obegränsade Telegram kanaler och grupper - endast de källor du litar på.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Backtest',
        metric: 'Spela om',
        metricVariant: 'teal',
        description: 'Spela om kanalhistorik på dina regler innan du riskerar livekapital.',
        layout: 'short',
        icon: 'history',
      },
    ],
  },
  features: {
    eyebrow: 'Plattformsfunktioner',
    title: 'Byggd för seriös signalkopiering',
    subtitle:
      'Allt du behöver för att automatisera Telegram-affärer utan att ge upp kontrollenâ illustreras med samma flöden som du använder i appen.',
    showcases: [
      {
        eyebrow: 'Signal kopiator',
        title: 'Kopiera Telegram-signaler till MT4 & MT5 med precision',
        description:
          'Spegla betrodda kanaler till dina mäklarkonton. TScopier analyserar poster, take-profits, intervallben och hanteringsinstruktioner - körs sedan med dina lotsregler, multi-handelsdelning och intervallskiktning på varje anslutet konto.',
        visual: 'copier',
      },
      {
        eyebrow: 'Kanalkontroll',
        title: 'Filter per kanal och sökordsregler',
        description:
          'Tillåt eller blockera instruktionstyper per kanal - stängningar, break-even-drag, SL/TP-justeringar och mer. Endast de signaler du vill nå din mäklare.',
        visual: 'filters',
      },
      {
        eyebrow: 'Meddelanderedigeringar',
        title: 'Signalmodifiering från redigerade meddelanden',
        description:
          'När en leverantör redigerar ett Telegram-meddelande för att ändra stop loss- eller take-profit-nivåer, plockar TScopier upp revisionen och uppdaterar din öppna korg på mäklaren – inga nya poster, bara synkroniserad SL/TP över varje ben.',
        visual: 'signalEdit',
      },
      {
        eyebrow: 'Backtest',
        title: 'Spela om kanalhistorik innan du sänder live',
        description:
          'Kör tidigare signaler mot dina manuella inställningar och se hur kopiatorn skulle ha handlat. Validera analys, lotlogik och resultat utan att riskera kapital.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Kopiatorloggar',
        title: 'Full transparens vid varje utförande',
        description:
          'Se exakt vad arbetaren analyserade, planerade och skickade – med millisekunders tidsstämplar så att du kan felsöka kanaler och verifiera fyllningar i realtid.',
        visual: 'logs',
      },
      {
        eyebrow: 'Marknadsverktyg',
        title: 'Nyheter och ekonomisk kalender inbyggd',
        description:
          'Spåra händelser med stor genomslagskraft och utvalda marknadsrubriker från samma instrumentpanel – pausa eventuellt kopieringen av nyheter med blackout-regler.',
        visual: 'news',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Signalkanal',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 nya signaler Â· just nu',
        hubLabel: 'TScopier',
        mt4Label: 'MT4 konto',
        mt4Meta: 'Kopiering · 0,10 lotsregler',
        mt5Label: 'MT5 konto',
        mt5Meta: 'Kopiering · multi-TP split',
        pillLayering: 'Range skiktning',
        pillLots: 'Partistorlek',
        pillChannels: 'Livekanaler',
      },
      filters: {
        allowLabel: 'Tillåta',
        ignoreLabel: 'Ignorera',
        rules: [
          {
            label: 'Stäng fullt läge',
            example: 'till exempel "stäng", "avsluta handel", "platta ut"',
            decision: 'allow',
          },
          {
            label: 'Break-even',
            example: 'till exempel "flytta SL till posten", "BE nu"',
            decision: 'allow',
          },
          {
            label: 'Justera TP',
            example: 'till exempel "ändra TP till 4600"',
            decision: 'allow',
          },
          {
            label: 'Stäng alla öppna affärer',
            example: 'till exempel "stäng alla", "platta ut alla"',
            decision: 'allow',
          },
          {
            label: 'Avbryt väntande beställningar',
            example: 'till exempel "avbryt gräns", "radera väntar"',
            decision: 'allow',
          },
        ],
      },
      signalEdit: {
        channelName: 'Gold Signals Pro',
        channelMeta: 'Telegram Â· meddelande redigerat',
        editedLabel: 'Redigerat',
        messageBuy: 'KÖP XAUUSD',
        beforeLabel: 'Tidigare',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: 'Uppdaterad',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 Â· TP2 4240',
        workerTitle: 'Kanalarbetare',
        workerMessage: 'Uppdaterad SL/TP på 7 öppna XAUUSD ben (inga nya affärer öppnade)',
        workerTime: 'Just nu',
      },
      backtest: {
        resultsTitle: 'Backtest resultat',
        resultsSubtitle: 'XAUUSD Â· Kanal',
        newRunLabel: 'Ny körning',
        totalPipsLabel: 'Totala kärnor',
        totalPips: '+544,0p',
        winRateLabel: 'Vinsthastighet',
        winRate: '67 %',
        winLossLabel: 'W/L',
        winLoss: '16/8',
        signalsLabel: 'Signaler',
        signalsCount: '24',
        signalsListLabel: '24 signaler',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: 'Alla TP:er',
            pips: '+62,0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL Träff',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: 'Partiell',
            pips: '+24,5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 maj, 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 maj, 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 maj, 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 maj, 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 maj, 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 maj, 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 maj, 19:48' },
        ],
      },
      news: {
        dayHeading: 'Torsdagen den 21 maj',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'Inflationstakt på årsbasis (april)',
            impact: 'high',
            actual: '1,40 %',
            forecast: '1,80 %',
            previous: '2,00 %',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'BoJs räntebeslut',
            impact: 'high',
            actual: '0,50 %',
            forecast: '0,50 %',
            previous: '0,25 %',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'Inledande anspråk på arbetslöshet',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'S&P Global Manufacturing PMI (maj)',
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
              'Guld (XAUUSD), Silver, Platinum Prognoser - Guld drar tillbaka när handlare oroar sig över...',
            source: 'fxempire.com',
            relativeTime: '10h sedan',
          },
          {
            headline: 'EUR/USD: Eurotjurar behöver en mjukare dollar för att bryta motståndet 1,10',
            source: 'fxstreet.com',
            relativeTime: '12h sedan',
          },
          {
            headline: 'USD/JPY håller sig nära toppar när avkastningsspreadarna ökar före NFP',
            source: 'investing.com',
            relativeTime: '14h sedan',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'Kom igång',
    title: 'Hur det fungerar',
    subtitle: 'Från Telegram kanal till mäklare, fyll i tre steg - med samma skärmar som du får i appen.',
    items: [
      {
        title: 'Anslut Telegram',
        description:
          'Länka ditt Telegram-konto, välj signalkanaler och anslut varje kanal till MT4/MT5-kontona som ska kopiera den.',
        visual: 'telegram',
      },
      {
        title: 'Konfigurera din mäklare',
        description:
          'Ställ in partistorlek, TP-delningar, intervallregler och tillåt/ignorera filter per kanal för varje länkat konto.',
        visual: 'configure',
      },
      {
        title: 'Kopiera signaler',
        description:
          'Kanalarbetaren analyserar varje meddelande; kopiatorloggar visar varje körning i realtid på din instrumentpanel.',
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
            brokers: ['MT5 Â· #88291'],
          },
          {
            name: 'FX Scalper VIP',
            username: 'fxscalpervip',
            active: true,
            brokers: ['MT4 Â· #44102'],
          },
        ],
      },
      configure: {
        accountName: 'IC Markets Â· MT5',
        login: 'Logga in #88291',
        lotSize: '0.10',
        rangeLabel: 'Range skiktning',
        rangeValue: '50 % · 3 kärnor',
        tpRows: [
          { label: 'TP1', percent: '50 %' },
          { label: 'TP2', percent: '30 %' },
          { label: 'TP3', percent: '20 %' },
        ],
        filters: [
          { label: 'Stängsignaler', decision: 'allow' },
          { label: 'Ändra SL / TP', decision: 'allow' },
          { label: 'Breakeven-drag', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Parsed KÖP XAUUSD Â· 2 TPs från Gold Signals Pro',
            time: '22 maj, 09:37',
          },
          {
            message: 'Skickas 0,10 lot till MT5 Â· konto #88291',
            time: '22 maj, 09:37',
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
    title: 'Vanliga frågor',
    subtitle: 'Snabba svar om installation, kopiering och vad som gör TScopier annorlunda.',
    items: [
      {
        question: 'Behöver jag ladda ner en EA eller köra en VPS?',
        answer:
          'Nej. TScopier är helt molnbaserad. Du loggar in från din webbläsare, ansluter Telegram och dina MT4/MT5 konton, och kopiatorn körs på vår infrastruktur – ingen expertrådgivare eller VPS att underhålla.',
      },
      {
        question: 'Fungerar TScopier med prop firms som förbjuder EA?',
        answer:
          'Ja. TScopier körs helt i molnet—inget installeras på din MT4/MT5-terminal. Du kan kopiera signaler till vilket prop-firmkonto som helst, oavsett om de tillåter Expert Advisors eller inte.',
      },
      {
        question: 'Vilka plattformar stöder TScopier?',
        answer:
          'Du ansluter Telegram signalkanaler och kopierar till MetaTrader 4- och MetaTrader 5-konton. Länka flera mäklare och dirigera varje kanal till de konton du väljer.',
      },
      {
        question: 'Hur snabbt kopieras affärer?',
        answer:
          'Vår pipeline är byggd för låg latens - vanligtvis under 150 ms från signalanalys till mäklarutskick - så att poster, ändringar och stängningar når din terminal medan priset fortfarande är relevant.',
      },
      {
        question: 'Hur många konton kan jag ansluta?',
        answer:
          'Du kan länka upp till 100 MT4/MT5 anslutningar per användare, beroende på din plan. Varje Telegram kanal kan kopplas till ett eller flera mäklarkonton från sidan Kanaler.',
      },
      {
        question: 'Läser TScopier mina privata Telegram-meddelanden?',
        answer:
          'TSCopier läser inte dina personliga chattar. Att ansluta Telegram ger endast åtkomst till kanaler och grupper du är medlem i så att kopiatorn kan ta emot signalmeddelanden från källor du lägger till.',
      },
      {
        question: 'Kan jag testa en kanal innan jag går live?',
        answer:
          'Ja. Använd Backtest för att spela om tidigare signaler från en kanal mot dina lotsregler, TP-delningar, intervallinställningar och filter – granska sedan resultaten innan du aktiverar livekopiering.',
      },
      {
        question: 'Stöder du sortimentsaffärer, skiktning och ledningssignaler?',
        answer:
          'Ja. TScopier hanterar enkel- och intervallposter, multi-TP-lotdelning, skiktning, nära-värre-poster, break-even-drag, partiella vinster och andra hanteringsinstruktioner - med tillåt/ignorera filter per kanal.',
      },
      {
        question: 'Vad ingår i Basic vs Advanced?',
        answer:
          'Basic täcker kärnkopiering på ett konto med backtests och viktiga filter. Advanced lägger till kopiering av flera konton, intervalllager, funktioner för automatisk hantering och obegränsade Telegram-kanaler. Se vår prissida för fullständig planinformation.',
      },
    ],
  },
  reviews: {
    title: 'Vad handlare säger',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsSv,
  },
  comparison: {
    eyebrow: 'Varför handlare byter',
    title: 'Gå upp i nivå med TScopier',
    subtitle: 'Typiska Telegram kopiatorer kontra en molnplattform byggd för hastighet, tydlighet och skala.',
    otherLabel: 'Andra kopiatorer',
    tscopierLabel: 'TScopier',
    cta: 'Börja gratis',
    rows: [
      {
        aspect: 'Inställning',
        other: 'Svårt att konfigurera – många användare behöver praktisk support bara för att gå live.',
        tscopier: 'Guidad onboarding i webbläsaren; de flesta handlare kopierar på cirka två minuter.',
      },
      {
        aspect: 'Instrumentbräda',
        other: 'Belamrade, trånga instrumentpaneler som begraver det som betyder något.',
        tscopier: 'En ren instrumentpanel fokuserad på kanaler, exekvering och kontotillstånd.',
      },
      {
        aspect: 'Konfiguration',
        other: 'För många rattar och reglage – lätt att felkonfigurera och tappa självförtroendet.',
        tscopier: 'Smarta standardinställningar med djup kontroll per kanal när du verkligen behöver det.',
      },
      {
        aspect: 'Infrastruktur',
        other: 'VPS krävs för att hålla EA igång dygnet runt.',
        tscopier: '100 % moln – ingen nedladdning, ingen EA och ingen VPS att underhålla.',
      },
      {
        aspect: 'Prop firms',
        other:
          'Många kopiatorer förlitar sig på Expert Advisors på din terminal—blockerade när en prop firm förbjuder automatiserad handel.',
        tscopier:
          'Molnbaserad exekvering utan EA på ditt konto—fungerar med alla prop firms, med eller utan tillåten EA.',
      },
      {
        aspect: 'Utförande',
        other: 'Långsam handel utförs efter att signalen träffat Telegram.',
        tscopier: 'Under 150 ms pipeline från analys till mäklarutskick.',
      },
      {
        aspect: 'Kontogränser',
        other: 'Ofta begränsat till 3â4 länkade konton.',
        tscopier: 'Upp till 100 MT4/MT5 anslutningar per användare.',
      },
      {
        aspect: 'Prissättning',
        other: 'Komplexa nivåer, tillägg och överraskningsgränser.',
        tscopier: 'Enkla planer med centrala kopiatorfunktioner ingår.',
      },
      {
        aspect: 'Handelshantering',
        other: 'Manuell ingripande behövs fortfarande för att ändra, dela och stänga.',
        tscopier: 'Automatiserade poster, skiktning, SL/TP-rörelser och hanteringssignaler.',
      },
      {
        aspect: 'Plattform',
        other: 'Nyckelfunktioner säljs som separata produkter eller uppgraderingar.',
        tscopier: 'Kopiator, backtest, loggar, nyheter och kalender i ett abonnemang.',
      },
      {
        aspect: 'Handel sammanslagning',
        other:
          '"Guldköp nu" öppnar byten, sedan öppnas "Guldköp nu" med SL/TP igen - du dubblar upp eller fixar det manuellt.',
        tscopier:
          '"Guldköp nu" öppnar handeln. När SL och TP kommer i nästa meddelande uppdaterar vi dessa affärer – vi öppnar inte Gold igen.',
      },
      {
        aspect: 'Redigerade meddelanden',
        other: 'Redigerade Telegram meddelanden ignoreras - du missar SL/TP-uppdateringar eller fixar byten för hand.',
        tscopier:
          'Signalmodifiering från redigerade meddelanden synkroniserar stop loss och vinster över din öppna korg – inga nya affärer.',
      },
      {
        aspect: 'Backtesting',
        other: 'Lite eller ingen riktig uppspelning av kanalhistorik på dina regler.',
        tscopier: 'Testa tidigare signaler mot dina faktiska kopieringsinställningar innan du går live.',
      },
    ],
  },
  pricing: {
    title: 'Välj din plan',
    subtitle: 'Börja kopiera signaler till dina handelskonton idag.',
  },
  planComparison: {
    eyebrow: 'Jämför planer',
    title: 'Hitta rätt passform',
    subtitle: 'Titta sida vid sida på vad varje plan innehåller.',
    basicColumn: 'Grundläggande',
    advancedColumn: 'Avancerad',
    customColumn: 'Beställnings',
    rows: [
      {
        feature: 'Mäklarkonton',
        basic: '1',
        advanced: '5 (upp till 100)',
        custom: 'Beställnings',
      },
      {
        feature: 'Signal backtests',
        basic: '5 / månad',
        advanced: 'Obegränsat',
        custom: 'Beställnings',
      },
      {
        feature: 'Telegram kanaler',
        basic: '5',
        advanced: 'Obegränsat',
        custom: 'Beställnings',
      },
      {
        feature: 'Take-profit nivåer',
        basic: '3 TP',
        advanced: 'Obegränsade TP/SL',
        custom: 'Beställnings',
      },
      {
        feature: 'Range trading & skiktning',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Auto breakeven & hantering',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Kanalsökord följer',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Prioriterat stöd',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Dedikerad onboarding',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Gratis provperiod',
        basic: 'no',
        advanced: '10 dagar',
        custom: 'Beställnings',
      },
      {
        feature: 'Utgångspris',
        basic: '$9,99 / månad',
        advanced: '$39,99 / månad',
        custom: 'Kontakta oss',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'Vanliga frågor om prissättning',
    title: 'Prisfrågor',
    subtitle: 'Fakturering, tester och planändringar förklaras.',
    items: [
      {
        question: 'Finns det en gratis provperiod?',
        answer:
          'Advanced inkluderar en 10-dagars gratis provperiod när du prenumererar. Basic faktureras från dag ett med 9,99 USD/månad (eller 95,90 USD/år med årlig fakturering). Du kan utforska instrumentpanelen innan du prenumererar, men livekopiering kräver en aktiv plan.',
      },
      {
        question: 'Vad är skillnaden mellan månads- och årsfakturering?',
        answer:
          'Årlig fakturering sparar 20 % jämfört med att betala månadsvis under ett helt år. Grundläggande sänkningar från $9,99/månad till $7,99/månad effektiv ($95,90/år). Avancerade sänkningar från $39,99/månad till $31,99/månad effektivt ($383,90/år). Extra konton på Advanced är också rabatterade på årsfakturering.',
      },
      {
        question: 'Hur fungerar extra konton på Advanced?',
        answer:
          'Advanced inkluderar 5 demo-/livemäklarkonton. Du kan lägga till upp till 95 till för 10 USD/konto/månad (eller 96 USD/konto/år på årlig fakturering), för maximalt 100 anslutna konton per användare.',
      },
      {
        question: 'Kan jag byta plan senare?',
        answer:
          'Ja. Uppgradera eller nedgradera när som helst från Fakturering i din instrumentpanel. Ändringar träder i kraft enligt din faktureringscykel, och Stripe hanterar proration när du flyttar mellan planerna.',
      },
      {
        question: 'Vilka betalningsmetoder accepterar du?',
        answer:
          'Vi accepterar större kredit- och betalkort genom Stripe. Fakturor och betalningshistorik finns att ladda ner från din faktureringssida.',
      },
      {
        question: 'När ska jag välja Custom?',
        answer:
          'Custom är för rekvisitafirmor, handelsteam eller högvolymoperatörer som behöver kontogränser, fakturering eller onboarding skräddarsydda för deras arbetsflöde. Kontakta säljare så sätter vi ihop en plan som passar.',
      },
      {
        question: 'Kan jag avboka när som helst?',
        answer:
          'Ja. Avbryt från Billing eller Stripe kundportal. Du behåller åtkomst till slutet av din nuvarande faktureringsperiod. Det finns inga långtidskontrakt på Basic eller Advanced.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} handlare köpte idag',
    purchaseToast: 'En handlare från {country} har precis köpt ett {plan}-abonnemang.',
    timeAgoJustNow: 'Just nu',
    timeAgoOneMinute: '1 minut sedan',
  },
  pricingSnippet: {
    basic: 'Grundläggande â $9,99/månad',
    advanced: 'Avancerat â 10 dagar gratis, sedan 39,99 USD/månad',
  },
  footer: {
    cta: {
      title: 'Är du redo att kopiera signaler utan manuellt arbete?',
      subtitle:
        'Länka Telegram, anslut MT4 eller MT5 och börja kopiera på några minuter â ingen VPS, ingen installation.',
      primary: 'Prova det gratis',
      secondary: 'Logga in',
    },
    tagline: 'Ultrasnabb Telegram signalkopiator för MetaTrader-konton.',
    columns: {
      product: 'Produkt',
      resources: 'Resurser',
      account: 'Konto',
    },
    links: {
      overview: 'Översikt',
      features: 'Drag',
      pricing: 'Prissättning',
      howItWorks: 'Hur det fungerar',
      faq: 'FAQ',
      docs: 'Dokumentation',
      status: 'Systemstatus',
      telegram: 'Telegram stöd',
      riskDisclaimer: 'Riskfriskrivning',
      termsOfService: 'Användarvillkor',
      privacyPolicy: 'Sekretesspolicy',
      cookiePolicy: 'Cookiepolicy',
      signIn: 'Logga in',
      signUp: 'Skapa konto',
      openApp: 'Öppna instrumentpanelen',
    },
    platforms: 'Fungerar med',
    copyright: '© {year} Tartarix Inc. Med ensamrätt.',
    disclaimer:
      'Handel innebär risk. TScopier är ett kopieringsverktyg â inte finansiell rådgivning.',
  },
}
