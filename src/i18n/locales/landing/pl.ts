import { testimonialsPl } from '../../testimonials/pl'
import type { LandingTranslations } from './types'

export const landingPl: LandingTranslations = {
  nav: {
    product: 'Produkt',
    features: 'Funkcje',
    pricing: 'Ceny',
    faq: 'FAQ',
    docs: 'Dokumenty',
    signIn: 'Zaloguj się',
    getStarted: 'Zacznij',
    dashboard: 'Panel kontrolny',
    menuOpen: 'Otwórz menu',
    menuClose: 'Zamknij menu',
  },
  hero: {
    trustedBy: 'Ponad 30 000 handlowców ze 156 krajów już dołączyło',
    avatarAlts: ['TScopier handlarz', 'TScopier handlarz', 'TScopier handlarz'],
    headline: 'Zamień sygnały Telegram w transakcje na żywo,',
    headlineAccent: '100% na autopilocie.',
    subheadline:
      'Skopiuj instrukcje handlowe od dostawców sygnału do swojego MT4/MT5 w mniej niż 2 minuty - bez skomplikowanych konfiguracji, bez EA i bez VPS. ',
    primaryCta: 'Wypróbuj za darmo',
    secondaryCta: 'Zaloguj się',
    imageAlt:
      'TScopier panel kontrolny z saldem, dziennym zyskiem, wynikami handlu i wykresami wzrostu konta',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'Na 5 połączonych kontach',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'vs wczoraj +712 USD',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 wygranych · 4 przegranych',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'Z 2 kont',
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
          message: 'Channel Gold Signals Pro · słuchacz podłączony',
          time: '22 maja, 09:36',
        },
        {
          message: 'Parsed KUP XAUUSD · 2 TP od Gold Signals Pro',
          time: '22 maja, 09:37',
        },
        {
          message: 'Wysłano zamówienie na MT5 · konto nr 88291',
          time: '22 maja, 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Złote sygnały Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 maja, 09:37',
        },
        {
          status: 'parsed',
          channel: 'VIP skalpera FX',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 maja, 09:35',
        },
        {
          status: 'executed',
          channel: 'Indeksy dzienne',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 maja, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    eyebrow: 'Inteligentniejsze kopiowanie zaczyna się od inteligentniejszych narzędzi',
    title:
      'Każda funkcja TScopier została stworzona, aby zapewnić kontrolę, przejrzystość i wymierne wyniki.',
    cards: [
      {
        label: 'Szybkość wykonania',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'Opóźnienie poniżej 150 ms od analizy sygnału do wysłania brokera w naszym potoku w chmurze.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Platforma chmurowa',
        metric: '100%',
        metricVariant: 'teal',
        description:
          'W 100% oparty na chmurze – bez pobierania, bez EA na terminalu i bez VPS. Działa z każdą firmą prop, z EA dozwolonym lub nie.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Skala brokerska',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Do 100 połączeń MT5/MT4 na użytkownika na połączonych kontach.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Operacje',
        metric: '24/7',
        metricVariant: 'teal',
        description: 'Operacje 24 godziny na dobę, 7 dni w tygodniu — kopiowanie każdej sesji bez nadzorowania lokalnej maszyny.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Mechanizm kopiowania',
        metric: 'Zaawansowane',
        metricVariant: 'teal',
        description:
          'Zaawansowana strategia kopiowania – szablony, filtry, analiza historyczna i reguły dla poszczególnych kanałów w jednym silniku.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Niezawodność',
        metric: '99,99%',
        metricVariant: 'teal',
        description: 'Czas pracy na poziomie 99,99%, dzięki czemu kopiarka pozostaje w trybie online, gdy rynki się zmieniają.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Kontrole ryzyka',
        metric: 'Nakładanie warstw',
        metricVariant: 'neutral',
        description: 'Nakładanie i zamykanie gorszych wpisów dla segmentów zasięgu i sygnałów multi-TP.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Tryby handlu',
        metric: 'Pojedynczy i zakres',
        metricVariant: 'neutral',
        description: 'Handel pojedynczy i zakresowy ze wspólnymi zasadami partii i instrukcjami zarządzania.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Bez ograniczeń',
        metricVariant: 'teal',
        description: 'Nieograniczona liczba kanałów i grup Telegram — tylko źródła, którym ufasz.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Test historyczny',
        metric: 'Powtórka',
        metricVariant: 'teal',
        description: 'Odtwórz historię kanału na swoich zasadach, zanim zaryzykujesz kapitał na żywo.',
        layout: 'short',
        icon: 'history',
      },
    ],
  },
  features: {
    eyebrow: 'Funkcje platformy',
    title: 'Zbudowany do poważnego kopiowania sygnału',
    subtitle:
      'Wszystko, czego potrzebujesz, aby zautomatyzować transakcje Telegram bez utraty kontroli – zilustrowane tymi samymi przepływami, których używasz w aplikacji.',
    showcases: [
      {
        eyebrow: 'Kopiarka sygnału',
        title: 'Kopiuj sygnały Telegram do MT4 i MT5 z precyzją',
        description:
          'Odbij zaufane kanały na swoich kontach brokerskich. TScopier analizuje wpisy, zyski, zakresy i instrukcje zarządzania, a następnie wykonuje je z regułami dotyczącymi partii, podziałem wielu transakcji i warstwami zakresu na każdym połączonym koncie.',
        visual: 'copier',
      },
      {
        eyebrow: 'Sterowanie kanałem',
        title: 'Filtry dla poszczególnych kanałów i reguły dotyczące słów kluczowych',
        description:
          'Zezwalaj lub blokuj typy instrukcji na kanał – zamykanie, przesuwanie progu rentowności, korekty SL/TP i inne. Tylko sygnały, które chcesz, docierają do Twojego brokera.',
        visual: 'filters',
      },
      {
        eyebrow: 'Zmiany wiadomości',
        title: 'Modyfikacja sygnału z edytowanych wiadomości',
        description:
          'Kiedy dostawca edytuje wiadomość Telegram, aby zmienić poziomy stop loss lub take-profit, TScopier przejmuje tę wersję i aktualizuje Twój otwarty koszyk u brokera – żadnych nowych wpisów, po prostu synchronizuje SL/TP na każdym etapie.',
        visual: 'signalEdit',
      },
      {
        eyebrow: 'Test historyczny',
        title: 'Odtwórz historię kanału przed rozpoczęciem transmisji na żywo',
        description:
          'Porównaj wcześniejsze sygnały z ustawieniami ręcznymi i zobacz, jak zachowałaby się kopiarka. Sprawdź analizę parsowania, logikę partii i wyniki bez ryzykowania kapitału.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Dzienniki kopiarki',
        title: 'Pełna przejrzystość każdej realizacji',
        description:
          'Zobacz dokładnie, co pracownik przeanalizował, zaplanował i wysłał – dzięki milisekundowym znacznikom czasu, dzięki czemu możesz debugować kanały i weryfikować wypełnienia w czasie rzeczywistym.',
        visual: 'logs',
      },
      {
        eyebrow: 'Narzędzia rynkowe',
        title: 'Wbudowane wiadomości i kalendarz ekonomiczny',
        description:
          'Śledź wydarzenia o dużym wpływie i wybrane nagłówki rynkowe z tego samego pulpitu nawigacyjnego — opcjonalnie wstrzymuj kopiowanie wiadomości z regułami blokowania dostępu.',
        visual: 'news',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Kanał sygnałowy',
        channelName: 'Złote sygnały Pro',
        channelMeta: '3 nowe sygnały · właśnie teraz',
        hubLabel: 'TScopier',
        mt4Label: 'MT4 konto',
        mt4Meta: 'Kopiowanie · Zasady 0,10 lota',
        mt5Label: 'MT5 konto',
        mt5Meta: 'Kopiowanie · podział na wiele TP',
        pillLayering: 'Nakładanie warstw',
        pillLots: 'Wielkość partii',
        pillChannels: 'Kanały na żywo',
      },
      filters: {
        allowLabel: 'Zezwól',
        ignoreLabel: 'Ignoruj',
        rules: [
          {
            label: 'Zamknij pełną pozycję',
            example: 'np. „zamknij”, „wyjdź z transakcji”, „spłaszcz”',
            decision: 'allow',
          },
          {
            label: 'Próg rentowności',
            example: 'np. „przenieś SL do wpisu”, „BE teraz”',
            decision: 'allow',
          },
          {
            label: 'Dostosuj TP',
            example: 'np. „zmień TP na 4600”',
            decision: 'allow',
          },
          {
            label: 'Zamknij wszystkie otwarte transakcje',
            example: 'np. „zamknij wszystko”, „spłaszcz wszystko”',
            decision: 'allow',
          },
          {
            label: 'Anuluj oczekujące zamówienia',
            example: 'np. „anuluj limit”, „usuń oczekujące”',
            decision: 'allow',
          },
        ],
      },
      signalEdit: {
        channelName: 'Złote sygnały Pro',
        channelMeta: 'Telegram · wiadomość edytowana',
        editedLabel: 'Edytowano',
        messageBuy: 'KUP XAUUSD',
        beforeLabel: 'Poprzedni',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: 'Zaktualizowano',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 · TP2 4240',
        workerTitle: 'Pracownik kanału',
        workerMessage: 'Zaktualizowano SL/TP na 7 otwartych nogach XAUUSD (żadnych nowych transakcji nie otwarto)',
        workerTime: 'Właśnie teraz',
      },
      backtest: {
        resultsTitle: 'Wyniki testu historycznego',
        resultsSubtitle: 'XAUUSD · Kanał',
        newRunLabel: 'Nowy bieg',
        totalPipsLabel: 'Całkowita liczba pipsów',
        totalPips: '+544,0p',
        winRateLabel: 'Współczynnik wygranych',
        winRate: '67%',
        winLossLabel: 'szer./dł',
        winLoss: '16/8',
        signalsLabel: 'Sygnały',
        signalsCount: '24',
        signalsListLabel: '24 sygnały',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '18.05.2026 09:37',
            outcome: 'Wszystkie TP',
            pips: '+62,0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '17.05.2026 14:22',
            outcome: 'SL Trafienie',
            pips: '-18,0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '16.05.2026 11:05',
            outcome: 'Częściowe',
            pips: '+24,5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 maja, 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 maja, 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 maja, 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 maja, 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 maja, 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 maja, 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 maja, 19:48' },
        ],
      },
      news: {
        dayHeading: 'Czwartek, 21 maja',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'Stopa inflacji rok do roku (kwiecień)',
            impact: 'high',
            actual: '1,40%',
            forecast: '1,80%',
            previous: '2,00%',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'Decyzja BoJ w sprawie stóp procentowych',
            impact: 'high',
            actual: '0,50%',
            forecast: '0,50%',
            previous: '0,25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'Wstępne wnioski o bezrobotnych',
            impact: 'high',
            actual: '228 tys',
            forecast: '230 tys',
            previous: '224 tys',
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
              'Prognozy dotyczące złota (XAUUSD), srebra i platyny ─ Złoto wycofuje się, gdy inwestorzy martwią się...',
            source: 'fxempire.com',
            relativeTime: '10 godzin temu',
          },
          {
            headline: 'EUR/USD: Eurobyki potrzebują słabszego dolara, aby przełamać opór przy 1,10',
            source: 'fxstreet.com',
            relativeTime: '12 godzin temu',
          },
          {
            headline: 'USD/JPY utrzymuje się blisko maksimów, a spready rentowności poszerzają się przed NFP',
            source: 'inwestowanie.com',
            relativeTime: '14 godzin temu',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'Zacznij',
    title: 'Jak to działa',
    subtitle: 'Z kanału Telegram do brokera wykonaj trzy kroki — korzystając z tych samych ekranów, co w aplikacji.',
    items: [
      {
        title: 'Połącz Telegram',
        description:
          'Połącz swoje konto Telegram, wybierz kanały sygnałowe i połącz każdy kanał z kontami MT4/MT5, które powinny go skopiować.',
        visual: 'telegram',
      },
      {
        title: 'Skonfiguruj swojego brokera',
        description:
          'Ustaw wielkość partii, podziały TP, zasady zakresu i filtry zezwalające/ignorowane na kanał dla każdego połączonego konta.',
        visual: 'configure',
      },
      {
        title: 'Kopiuj sygnały',
        description:
          'Pracownik kanału analizuje każdą wiadomość; dzienniki kopiarki pokazują każde wykonanie w czasie rzeczywistym na pulpicie nawigacyjnym.',
        visual: 'copy',
      },
    ],
    visuals: {
      telegram: {
        channels: [
          {
            name: 'Złote sygnały Pro',
            username: 'goldsignalspro',
            active: true,
            brokers: ['MT5 · #88291'],
          },
          {
            name: 'VIP skalpera FX',
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
        rangeLabel: 'Nakładanie warstw',
        rangeValue: '50% · 3 pipsy',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'Sygnały zamknięcia', decision: 'allow' },
          { label: 'Zmień SL / TP', decision: 'allow' },
          { label: 'Ruchy na rentowność', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Parsed KUP XAUUSD · 2 TP od Gold Signals Pro',
            time: '22 maja, 09:37',
          },
          {
            message: 'Wysłano 0,10 lota na adres MT5 · konto nr 88291',
            time: '22 maja, 09:37',
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
    title: 'Często zadawane pytania',
    subtitle: 'Szybkie odpowiedzi na temat konfiguracji, kopiowania i tego, co wyróżnia TScopier.',
    items: [
      {
        question: 'Czy muszę pobrać EA lub uruchomić VPS?',
        answer:
          'Nie. TScopier jest w pełni oparty na chmurze. Logujesz się w przeglądarce, łączysz Telegram i swoje konta MT4/MT5, a kopiarka działa w oparciu o naszą infrastrukturę — ​​nie trzeba instalować programu Expert Advisor ani VPS, który wymaga konserwacji.',
      },
      {
        question: 'Czy TScopier działa z firmami prop, które zakazują EA?',
        answer:
          'Tak. TScopier działa w całości w chmurze — nic nie jest instalowane na terminalu MT4/MT5. Możesz kopiować sygnały na dowolne konto firmy prop, niezależnie od tego, czy zezwala na Expert Advisors.',
      },
      {
        question: 'Jakie platformy obsługuje TScopier?',
        answer:
          'Podłączasz kanały sygnałowe Telegram i kopiujesz je na konta MetaTrader 4 i MetaTrader 5. Połącz wielu brokerów i kieruj każdy kanał do wybranych kont.',
      },
      {
        question: 'Jak szybko kopiowane są transakcje?',
        answer:
          'Nasz potok jest zbudowany z myślą o małych opóźnieniach — zwykle poniżej 150 ms od analizy sygnału do wysłania brokera — dzięki czemu wpisy, modyfikacje i zamknięcia docierają do Twojego terminala, gdy cena jest nadal aktualna.',
      },
      {
        question: 'Ile kont mogę podłączyć?',
        answer:
          'Możesz połączyć do 100 połączeń MT4/MT5 na użytkownika, w zależności od planu. Każdy kanał Telegram można połączyć z jednym lub większą liczbą kont brokerskich na stronie Kanały.',
      },
      {
        question: 'Czy TScopier czyta moje prywatne wiadomości Telegram?',
        answer:
          'TSCopier nie czyta Twoich osobistych czatów. Podłączenie Telegram zapewnia dostęp tylko do kanałów i grup, których jesteś członkiem, dzięki czemu kopiarka może odbierać komunikaty sygnałowe z dodanych przez Ciebie źródeł.',
      },
      {
        question: 'Czy mogę przetestować kanał przed rozpoczęciem transmisji na żywo?',
        answer:
          'Tak. Użyj testu historycznego, aby odtworzyć wcześniejsze sygnały z kanału pod kątem zasad dotyczących partii, podziałów TP, ustawień zakresu i filtrów, a następnie przejrzyj wyniki przed włączeniem kopiowania na żywo.',
      },
      {
        question: 'Czy obsługujesz transakcje zakresowe, warstwowanie i sygnały zarządzania?',
        answer:
          'Tak. TScopier obsługuje wpisy pojedyncze i zakresowe, dzielenie partii na wiele TP, nakładanie warstw, wpisy o najgorszym zamknięciu, ruchy progowe, zyski częściowe i inne instrukcje zarządzania – z filtrami zezwalania/ignorowania dla poszczególnych kanałów.',
      },
      {
        question: 'Co obejmuje wersja podstawowa i zaawansowana?',
        answer:
          'Basic obejmuje kopiowanie rdzenia na jednym koncie z testami historycznymi i niezbędnymi filtrami. Wersja Advanced dodaje kopiowanie wielu kont, warstwowanie zakresu, funkcje automatycznego zarządzania i nieograniczoną liczbę kanałów Telegram. Zobacz naszą stronę z cenami, aby uzyskać szczegółowe informacje na temat planu.',
      },
    ],
  },
  reviews: {
    title: 'Co mówią handlowcy',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsPl,
  },
  comparison: {
    eyebrow: 'Dlaczego inwestorzy zmieniają',
    title: 'Zwiększ poziom dzięki TScopier',
    subtitle: 'Typowe kopiarki Telegram a platforma chmurowa zbudowana pod kątem szybkości, przejrzystości i skali.',
    otherLabel: 'Inne kopiarki',
    tscopierLabel: 'TScopier',
    cta: 'Zacznij bezpłatnie',
    rows: [
      {
        aspect: 'Konfiguracja',
        other: 'Trudna konfiguracja — wielu użytkowników potrzebuje praktycznej pomocy, aby rozpocząć transmisję na żywo.',
        tscopier: 'Dołączanie z przewodnikiem w przeglądarce; większość traderów kopiuje w ciągu około dwóch minut.',
      },
      {
        aspect: 'Panel kontrolny',
        other: 'Zagracone, zatłoczone pulpity nawigacyjne, które zakrywają to, co ważne.',
        tscopier: 'Przejrzysty pulpit nawigacyjny skupiający się na kanałach, wykonaniu i kondycji konta.',
      },
      {
        aspect: 'Konfiguracja',
        other: 'Zbyt wiele pokręteł i przełączników — łatwo je źle skonfigurować i stracić pewność siebie.',
        tscopier: 'Inteligentne ustawienia domyślne z głęboką kontrolą każdego kanału, kiedy naprawdę tego potrzebujesz.',
      },
      {
        aspect: 'Infrastruktura',
        other: 'VPS wymagany, aby EA działały przez całą dobę.',
        tscopier: '100% chmura – bez pobierania, bez EA i bez obsługi VPS.',
      },
      {
        aspect: 'Firmy prop',
        other:
          'Wiele kopiarek opiera się na Expert Advisors na terminalu — zablokowane, gdy firma prop zabrania handlu automatycznego.',
        tscopier:
          'Wykonanie w chmurze bez EA na koncie — działa ze wszystkimi firmami prop, z EA dozwolonym lub nie.',
      },
      {
        aspect: 'Wykonanie',
        other: 'Powolna realizacja transakcji po uderzeniu sygnału Telegram.',
        tscopier: 'Potok trwający poniżej 150 ms od analizy do wysyłki brokera.',
      },
      {
        aspect: 'Limity konta',
        other: 'Często ograniczone do 3–4 połączonych kont.',
        tscopier: 'Do 100 połączeń MT4/MT5 na użytkownika.',
      },
      {
        aspect: 'Ceny',
        other: 'Złożone poziomy, dodatki i limity niespodzianek.',
        tscopier: 'Proste plany z uwzględnieniem podstawowych funkcji kopiarki.',
      },
      {
        aspect: 'Zarządzanie handlem',
        other: 'Nadal konieczna jest ręczna interwencja w przypadku modyfikacji, częściowych i zamknięć.',
        tscopier: 'Zautomatyzowane wpisy, nakładanie warstw, ruchy SL/TP i sygnały zarządzania.',
      },
      {
        aspect: 'Platforma',
        other: 'Kluczowe funkcje sprzedawane jako osobne produkty lub aktualizacje.',
        tscopier: 'Kopiarka, analiza historyczna, dzienniki, aktualności i kalendarz w jednej subskrypcji.',
      },
      {
        aspect: 'Fuzja handlowa',
        other:
          '„Kup teraz złoto” otwiera transakcje, następnie „Kup teraz złoto” z SL/TP otwiera się ponownie – podwajasz lub naprawiasz to ręcznie.',
        tscopier:
          '„Kup teraz złoto” otwiera transakcję. Kiedy w następnej wiadomości dostaną SL i TP, aktualizujemy te transakcje – nie otwieramy ponownie złota.',
      },
      {
        aspect: 'Edytowane wiadomości',
        other: 'Edytowane wiadomości Telegram są ignorowane — przegapiasz aktualizacje SL/TP lub ręcznie naprawiasz transakcje.',
        tscopier:
          'Modyfikacja sygnału z edytowanych wiadomości synchronizuje stop loss i take-profit w całym otwartym koszyku – bez nowych transakcji.',
      },
      {
        aspect: 'Testowanie historyczne',
        other: 'Niewiele lub brak prawdziwego odtwarzania historii kanału na Twoich zasadach.',
        tscopier: 'Przed publikacją przetestuj wcześniejsze sygnały w porównaniu z rzeczywistymi ustawieniami kopiowania.',
      },
    ],
  },
  pricing: {
    title: 'Wybierz swój plan',
    subtitle: 'Zacznij już dziś kopiować sygnały na swoje konta handlowe.',
  },
  planComparison: {
    eyebrow: 'Porównaj plany',
    title: 'Znajdź odpowiednie dopasowanie',
    subtitle: 'Przyjrzyj się bliżej, co obejmuje każdy plan.',
    basicColumn: 'Podstawowy',
    advancedColumn: 'Zaawansowane',
    customColumn: 'Niestandardowe',
    rows: [
      {
        feature: 'Konta brokerskie',
        basic: '1',
        advanced: '5 (do 100)',
        custom: 'Niestandardowe',
      },
      {
        feature: 'Testy historyczne sygnału',
        basic: '5 / miesiąc',
        advanced: 'Bez ograniczeń',
        custom: 'Niestandardowe',
      },
      {
        feature: 'Telegram kanały',
        basic: '5',
        advanced: 'Bez ograniczeń',
        custom: 'Niestandardowe',
      },
      {
        feature: 'Poziomy realizacji zysku',
        basic: '3 TP',
        advanced: 'Nieograniczona liczba TP/SL',
        custom: 'Niestandardowe',
      },
      {
        feature: 'Handel asortymentem i nakładanie warstw',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Automatyczny próg rentowności i zarządzanie',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Śledzenie słowa kluczowego kanału',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Wsparcie priorytetowe',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Dedykowane wdrożenie',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Bezpłatny okres próbny',
        basic: 'no',
        advanced: '10 dni',
        custom: 'Niestandardowe',
      },
      {
        feature: 'Cena wywoławcza',
        basic: '9,99 USD / miesiąc',
        advanced: '39,99 USD / miesiąc',
        custom: 'Skontaktuj się z nami',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'Często zadawane pytania dotyczące cen',
    title: 'Pytania dotyczące cen',
    subtitle: 'Wyjaśnienie rozliczeń, wersji próbnych i zmian w planach.',
    items: [
      {
        question: 'Czy istnieje bezpłatny okres próbny?',
        answer:
          'Advanced obejmuje 10-dniowy bezpłatny okres próbny w przypadku subskrypcji. Opłata za wersję podstawową jest naliczana od pierwszego dnia w wysokości 9,99 USD/miesiąc (lub 95,90 USD/rok przy rozliczeniu rocznym). Możesz przeglądać pulpit nawigacyjny przed subskrypcją, ale kopiowanie na żywo wymaga aktywnego planu.',
      },
      {
        question: 'Jaka jest różnica między rozliczeniami miesięcznymi i rocznymi?',
        answer:
          'Rozliczenia roczne pozwalają zaoszczędzić 20% w porównaniu z płatnościami miesięcznymi za cały rok. Podstawowe spadki z 9,99 USD miesięcznie do 7,99 USD miesięcznie (95,90 USD rocznie). Opcja Advanced spada z 39,99 USD miesięcznie do 31,99 USD miesięcznie (383,90 USD rocznie). Dodatkowe konta w wersji Advanced są również objęte zniżką w przypadku rozliczeń rocznych.',
      },
      {
        question: 'Jak działają dodatkowe konta w trybie Advanced?',
        answer:
          'Advanced obejmuje 5 rachunków brokerskich/demonstracyjnych na żywo. Możesz dodać maksymalnie 95 kolejnych w cenie 10 USD/konto/miesiąc (lub 96 USD/konto/rok przy rozliczeniu rocznym), co daje maksymalnie 100 połączonych kont na użytkownika.',
      },
      {
        question: 'Czy mogę zmienić plan później?',
        answer:
          'Tak. Przejdź na wyższą lub niższą wersję w dowolnym momencie, korzystając z opcji Rozliczenia na pulpicie nawigacyjnym. Zmiany wchodzą w życie zgodnie z Twoim cyklem rozliczeniowym, a Stripe obsługuje proporcjonalność podczas przechodzenia między planami.',
      },
      {
        question: 'Jakie metody płatności akceptujecie?',
        answer:
          'Akceptujemy główne karty kredytowe i debetowe za pośrednictwem Stripe. Faktury i historię płatności można pobrać ze strony Rozliczenia.',
      },
      {
        question: 'Kiedy powinienem wybrać opcję Niestandardową?',
        answer:
          'Niestandardowy jest przeznaczony dla firm rekwizycyjnych, zespołów handlowych lub operatorów o dużym wolumenie, którzy potrzebują limitów konta, rozliczeń lub wdrożenia dostosowanych do ich przepływu pracy. Skontaktuj się z działem sprzedaży, a my opracujemy odpowiedni plan.',
      },
      {
        question: 'Czy mogę anulować rezerwację w dowolnym momencie?',
        answer:
          'Tak. Anuluj w obszarze rozliczeń lub portalu klienta Stripe. Dostęp zachowujesz do końca bieżącego okresu rozliczeniowego. Na poziomie Podstawowym i Zaawansowanym nie ma umów długoterminowych.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} handlowcy kupili dzisiaj',
    purchaseToast: 'Trader z {country} właśnie kupił subskrypcję {plan}.',
    timeAgoJustNow: 'Właśnie teraz',
    timeAgoOneMinute: '1 minutę temu',
  },
  pricingSnippet: {
    basic: 'Podstawowy – 9,99 USD/miesiąc',
    advanced: 'Advanced – 10 dni bezpłatnie, następnie 39,99 USD/miesiąc',
  },
  footer: {
    cta: {
      title: 'Gotowy do kopiowania sygnałów bez pracy ręcznej?',
      subtitle:
        'Link Telegram, podłącz MT4 lub MT5 i rozpocznij kopiowanie w ciągu kilku minut — bez VPS, bez instalacji.',
      primary: 'Wypróbuj za darmo',
      secondary: 'Zaloguj się',
    },
    tagline: 'Ultraszybka kopiarka sygnału Telegram dla kont MetaTrader.',
    columns: {
      product: 'Produkt',
      resources: 'Zasoby',
      account: 'Konto',
    },
    links: {
      overview: 'Przegląd',
      features: 'Funkcje',
      pricing: 'Ceny',
      howItWorks: 'Jak to działa',
      faq: 'FAQ',
      docs: 'Dokumentacja',
      status: 'Stan systemu',
      telegram: 'Telegram wsparcie',
      riskDisclaimer: 'Zastrzeżenie dotyczące ryzyka',
      termsOfService: 'Warunki korzystania z usługi',
      privacyPolicy: 'Polityka prywatności',
      cookiePolicy: 'Polityka dotycząca plików cookie',
      signIn: 'Zaloguj się',
      signUp: 'Utwórz konto',
      openApp: 'Otwórz pulpit nawigacyjny',
    },
    platforms: 'Współpracuje z',
    copyright: 'Â© {year} Tartarix Inc. Wszelkie prawa zastrzeżone.',
    disclaimer:
      'Handel wiąże się z ryzykiem. TScopier to narzędzie do kopiowania, a nie porada finansowa.',
  },
}
