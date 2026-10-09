import { testimonialsAr } from '../../testimonials/ar'
import type { LandingTranslations } from './types'

export const landingAr: LandingTranslations = {
  nav: {
    product: 'المنتج',
    features: 'الميزات',
    pricing: 'الأسعار',
    faq: 'الأسئلة الشائعة',
    docs: 'التوثيق',
    signIn: 'تسجيل الدخول',
    getStarted: 'إنشاء حساب',
    dashboard: 'لوحة التحكم',
    menuOpen: 'فتح القائمة',
    menuClose: 'إغلاق القائمة',
  },
  hero: {
    headline: 'إشارات Telegram. تُنسخ تلقائيًا.',
    subheadline:
      'أتمت تداولاتك من Telegram أو Discord أو TradingView أو حساب رئيسي إلى أكثر من 8 منصات وساطة في أقل من 50 مللي ثانية. بدون VPS.',
    socialProof: 'مصنف رقم 1 كناسخ إشارات Telegram سحابي',
    primaryCta: 'ابدأ تجربتك المجانية لمدة 5 أيام',
    secondaryCta: 'تسجيل الدخول',
    imageAlt:
      'لوحة تحكم UniCopier تعرض الرصيد والربح اليومي ونتائج التداول ومخططات نمو الحساب',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'عبر 5 حسابات متصلة',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'مقارنة بالأمس +712 USD',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 رابحة · 4 خاسرة',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'من حسابين',
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
          message: 'قناة Gold Signals Pro · المستمع متصل',
          time: '22 مايو، 09:36',
        },
        {
          message: 'تم تحليل BUY XAUUSD · 2 TP من Gold Signals Pro',
          time: '22 مايو، 09:37',
        },
        {
          message: 'تم إرسال الأمر إلى MT5 · الحساب #88291',
          time: '22 مايو، 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'إشارات الذهب المحترفة',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 مايو، 09:37',
        },
        {
          status: 'parsed',
          channel: 'مضارب FX VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 مايو، 09:35',
        },
        {
          status: 'executed',
          channel: 'المؤشرات اليومية',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 مايو، 09:31',
        },
      ],
    },
  },
  whyChoose: {
    statsCaption: 'يستخدمه متداولون من أشهر مزوّدي إشارات Telegram',
    stats: [
      { label: 'المتداولون', value: '30K+' },
      { label: 'الوسطاء المتصلون', value: '25K+' },
      { label: 'قنوات Telegram النشطة', value: '150K+' },
      { label: 'الصفقات المفتوحة', value: '500K+' },
    ],
    eyebrow: 'النسخ الأذكى يبدأ بأدوات أذكى',
    title:
      'صُمّم كل ميزة في UniCopier لتمنحك التحكم والشفافية ونتائج قابلة للقياس.',
    cards: [
      {
        label: 'سرعة التنفيذ',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'زمن استجابة أقل من 150 مللي ثانية من تحليل الإشارة إلى إرسال الوسيط في مسارنا السحابي.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'منصة سحابية',
        metric: '100%',
        metricVariant: 'teal',
        description:
          '100% سحابي — بلا تنزيلات، بلا EA على المنصة، وبلا VPS. يعمل مع أي شركة تمويل، سواء سُمح بـ EA أم لا.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'نطاق الوسطاء',
        metric: '100',
        metricVariant: 'neutral',
        description: 'حتى 100 اتصال MT5/MT4 لكل مستخدم عبر الحسابات المتصلة.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'التشغيل',
        metric: '24/7',
        metricVariant: 'teal',
        description: 'تشغيل على مدار الساعة طوال أيام الأسبوع — نسخ كل جلسة دون الإشراف على جهاز محلي.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'محرك النسخ',
        metric: 'متقدم',
        metricVariant: 'teal',
        description:
          'استراتيجية نسخ متقدمة — قوالب وفلاتر واختبار تاريخي وقواعد لكل قناة في محرك واحد.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'الموثوقية',
        metric: '99.99%',
        metricVariant: 'teal',
        description: 'وقت تشغيل 99.99% ليبقى الناسخ متصلًا عندما تتحرك الأسواق.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'ضوابط المخاطر',
        metric: 'تدرج',
        metricVariant: 'neutral',
        description: 'تدرج النطاق وإغلاق الدخولات الأسوأ لقطاعات النطاق وإشارات TP المتعددة.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'أوضاع التداول',
        metric: 'فردي ونطاق',
        metricVariant: 'neutral',
        description: 'تداول فردي ونطاقي بقواعد لوت مشتركة وتعليمات إدارة.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'متعدد اللغات',
        metric: 'الإشارات',
        metricVariant: 'teal',
        description: 'اقرأ الشراء والبيع وSL وTP من قنوات بالإنجليزية والإسبانية والروسية والبولندية وغيرها.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'الاختبار التاريخي',
        metric: 'إعادة',
        metricVariant: 'teal',
        description: 'أعد تشغيل تاريخ القناة وفق قواعدك قبل المخاطرة برأس المال الحي.',
        layout: 'short',
        icon: 'history',
      },
    ],
  },
  features: {
    eyebrow: 'ميزات المنصة',
    title: 'مبني للنسخ الجاد للإشارات',
    subtitle:
      'كل ما تحتاجه لأتمتة صفقات Telegram دون فقدان التحكم — موضّح بنفس التدفقات التي تستخدمها في التطبيق.',
    showcases: [
      {
        eyebrow: 'ناسخ الإشارات',
        title: 'انسخ إشارات Telegram إلى MT4 وMT5 بدقة',
        description:
          'عكس القنوات الموثوقة على حسابات الوسيط الخاصة بك. يحلل UniCopier الدخولات والأرباح والنطاقات وتعليمات الإدارة، ثم ينفّذها بقواعد اللوت وتقسيم الصفقات المتعددة وطبقات النطاق على كل حساب متصل.',
        visual: 'copier',
      },
      {
        eyebrow: 'إشارات متعددة اللغات',
        title: 'يدعم الإشارات بلغات متعددة',
        description:
          'انسخ القنوات التي تنشر بالإنجليزية والإسبانية والفرنسية والروسية والبولندية واليابانية وغيرها. يتعرّف UniCopier على الشراء/البيع وSL وTP وعبارات الإدارة بكل لغة، مع تعلّم لكل قناة لصياغة المزوّد الدقيقة.',
        visual: 'multilingual',
      },
      {
        eyebrow: 'التحكم بالقناة',
        title: 'فلاتر لكل قناة وقواعد الكلمات المفتاحية',
        description:
          'اسمح أو احجب أنواع التعليمات لكل قناة — الإغلاق، نقل وقف الخسارة إلى نقطة التعادل، تعديلات SL/TP وغيرها. فقط الإشارات التي تريدها تصل إلى وسيطك.',
        visual: 'filters',
      },
      {
        eyebrow: 'تعديلات الرسائل',
        title: 'تعديل الإشارة من الرسائل المحرّرة',
        description:
          'عندما يحرّر المزوّد رسالة Telegram لتغيير مستويات وقف الخسارة أو جني الأرباح، يلتقط UniCopier تلك النسخة ويحدّث سلة الصفقات المفتوحة لدى الوسيط — بلا دخولات جديدة، فقط مزامنة SL/TP في كل مرحلة.',
        visual: 'signalEdit',
      },
      {
        eyebrow: 'الاختبار التاريخي',
        title: 'أعد تشغيل تاريخ القناة قبل البث الحي',
        description:
          'قارن الإشارات السابقة بإعداداتك اليدوية وشاهد كيف كان سيتصرف الناسخ. راجع تحليل التحليل ومنطق اللوت والنتائج دون المخاطرة برأس المال.',
        visual: 'backtest',
      },
      {
        eyebrow: 'سجلات الناسخ',
        title: 'شفافية كاملة لكل تنفيذ',
        description:
          'شاهد بالضبط ما حلّله العامل وخطّط له وأرسله — بطوابع زمنية بالميلي ثانية لتصحيح القنوات والتحقق من التنفيذ في الوقت الفعلي.',
        visual: 'logs',
      },
      {
        eyebrow: 'أدوات السوق',
        title: 'أخبار وتقويم اقتصادي مدمجان',
        description:
          'تابع الأحداث عالية التأثير والعناوين السوقية المختارة من نفس لوحة التحكم — مع إيقاف النسخ اختياريًا أثناء الأخبار بقواعد الحظر.',
        visual: 'news',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'قناة الإشارات',
        channelName: 'إشارات الذهب المحترفة',
        channelMeta: '3 إشارات جديدة · الآن',
        hubLabel: 'UniCopier',
        mt4Label: 'حساب MT4',
        mt4Meta: 'نسخ · قواعد 0.10 لوت',
        mt5Label: 'حساب MT5',
        mt5Meta: 'نسخ · تقسيم TP متعدد',
        pillLayering: 'تدرج النطاق',
        pillLots: 'حجم اللوت',
        pillChannels: 'قنوات حية',
      },
      filters: {
        allowLabel: 'سماح',
        ignoreLabel: 'تجاهل',
        rules: [
          {
            label: 'إغلاق المركز بالكامل',
            example: 'مثل «أغلق»، «اخرج من الصفقة»، «أغلق الكل»',
            decision: 'allow',
          },
          {
            label: 'نقطة التعادل',
            example: 'مثل «انقل SL إلى الدخول»، «BE الآن»',
            decision: 'allow',
          },
          {
            label: 'تعديل TP',
            example: 'مثل «غيّر TP إلى 4600»',
            decision: 'allow',
          },
          {
            label: 'إغلاق جميع الصفقات المفتوحة',
            example: 'مثل «أغلق الكل»، «أغلق كل شيء»',
            decision: 'allow',
          },
          {
            label: 'إلغاء الأوامر المعلّقة',
            example: 'مثل «ألغِ الحد»، «احذف المعلّق»',
            decision: 'allow',
          },
        ],
      },
      multilingual: {
        languagesBadge: 'أكثر من 10 لغات',
        moreLanguages: 'الألمانية والعربية والبرتغالية والإيطالية والمزيد',
        parsedLabel: 'تم التحليل',
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
        channelName: 'إشارات الذهب المحترفة',
        channelMeta: 'Telegram · رسالة معدّلة',
        editedLabel: 'معدّل',
        messageBuy: 'شراء XAUUSD',
        beforeLabel: 'السابق',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: 'محدّث',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 · TP2 4240',
        workerTitle: 'عامل القناة',
        workerMessage: 'تم تحديث SL/TP على 7 أرجل XAUUSD مفتوحة (لم تُفتح صفقات جديدة)',
        workerTime: 'الآن',
      },
      backtest: {
        resultsTitle: 'نتائج الاختبار التاريخي',
        resultsSubtitle: 'XAUUSD · القناة',
        newRunLabel: 'تشغيل جديد',
        totalPipsLabel: 'إجمالي النقاط',
        totalPips: '+544,0p',
        winRateLabel: 'نسبة الربح',
        winRate: '67%',
        winLossLabel: 'خ/ر',
        winLoss: '16/8',
        signalsLabel: 'الإشارات',
        signalsCount: '24',
        signalsListLabel: '24 إشارة',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '18.05.2026 09:37',
            outcome: 'جميع TP',
            pips: '+62,0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '17.05.2026 14:22',
            outcome: 'إصابة SL',
            pips: '-18,0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '16.05.2026 11:05',
            outcome: 'جزئي',
            pips: '+24,5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 مايو، 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 مايو، 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 مايو، 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 مايو، 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 مايو، 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 مايو، 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 مايو، 19:48' },
        ],
      },
      news: {
        dayHeading: 'الخميس، 21 مايو',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'معدل التضخم سنويًا (أبريل)',
            impact: 'high',
            actual: '1,40%',
            forecast: '1,80%',
            previous: '2,00%',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'قرار بنك اليابان بشأن أسعار الفائدة',
            impact: 'high',
            actual: '0,50%',
            forecast: '0,50%',
            previous: '0,25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'طلبات إعانة البطالة الأولية',
            impact: 'high',
            actual: '228 ألف',
            forecast: '230 ألف',
            previous: '224 ألف',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'مؤشر S&P Global لقطاع التصنيع PMI (مايو)',
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
              'توقعات الذهب (XAUUSD) والفضة والبلاتين ─ يتراجع الذهب مع قلق المستثمرين...',
            source: 'fxempire.com',
            relativeTime: 'منذ 10 ساعات',
          },
          {
            headline: 'EUR/USD: يحتاج صعود اليورو إلى دولار أضعف لاختراق المقاومة عند 1.10',
            source: 'fxstreet.com',
            relativeTime: 'منذ 12 ساعة',
          },
          {
            headline: 'USD/JPY يبقى قرب القمم وتتسع فروق العوائد قبل NFP',
            source: 'investing.com',
            relativeTime: 'منذ 14 ساعة',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'ابدأ',
    title: 'كيف يعمل',
    subtitle: 'من قناة Telegram إلى الوسيط في ثلاث خطوات — باستخدام نفس الشاشات التي تستخدمها في التطبيق.',
    items: [
      {
        title: 'اربط Telegram',
        description:
          'اربط حساب Telegram، اختر قنوات الإشارات، واربط كل قناة بحسابات MT4/MT5 التي يجب أن تنسخها.',
        visual: 'telegram',
      },
      {
        title: 'اضبط وسيطك',
        description:
          'حدّد حجم اللوت وتقسيمات TP وقواعد النطاق وفلاتر السماح/التجاهل لكل قناة على كل حساب متصل.',
        visual: 'configure',
      },
      {
        title: 'انسخ الإشارات',
        description:
          'يحلل عامل القناة كل رسالة؛ وتعرض سجلات الناسخ كل تنفيذ في الوقت الفعلي على لوحة التحكم.',
        visual: 'copy',
      },
    ],
    visuals: {
      telegram: {
        channels: [
          {
            name: 'إشارات الذهب المحترفة',
            username: 'goldsignalspro',
            active: true,
            brokers: ['MT5 · #88291'],
          },
          {
            name: 'مضارب FX VIP',
            username: 'fxscalpervip',
            active: true,
            brokers: ['MT4 · #44102'],
          },
        ],
      },
      configure: {
        accountName: 'IC Markets · MT5',
        login: 'تسجيل الدخول #88291',
        lotSize: '0.10',
        rangeLabel: 'تدرج النطاق',
        rangeValue: '50% · 3 نقاط',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'إشارات الإغلاق', decision: 'allow' },
          { label: 'تعديل SL / TP', decision: 'allow' },
          { label: 'حركات التعادل', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'تم تحليل BUY XAUUSD · 2 TP من Gold Signals Pro',
            time: '22 مايو، 09:37',
          },
          {
            message: 'تم إرسال 0.10 لوت إلى MT5 · الحساب #88291',
            time: '22 مايو، 09:37',
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
    eyebrow: 'الأسئلة الشائعة',
    title: 'الأسئلة المتكررة',
    subtitle: 'إجابات سريعة حول الإعداد والنسخ وما يميّز UniCopier.',
    items: [
      {
        question: 'هل أحتاج لتنزيل EA أو تشغيل VPS؟',
        answer:
          'لا. UniCopier سحابي بالكامل. تسجّل الدخول من المتصفح، تربط Telegram وحسابات MT4/MT5، ويعمل الناسخ على بنيتنا التحتية — بلا تثبيت Expert Advisor ولا VPS يحتاج صيانة.',
      },
      {
        question: 'هل يعمل UniCopier مع شركات التمويل التي تحظر EA؟',
        answer:
          'نعم. يعمل UniCopier بالكامل في السحابة — لا يُثبَّت شيء على منصة MT4/MT5. يمكنك نسخ الإشارات إلى أي حساب شركة تمويل، سواء سُمح بـ Expert Advisors أم لا.',
      },
      {
        question: 'ما المنصات التي يدعمها UniCopier؟',
        answer:
          'تربط قنوات إشارات Telegram وتنسخها إلى حسابات MetaTrader 4 وMetaTrader 5. اربط عدة وسطاء ووجّه كل قناة إلى الحسابات المختارة.',
      },
      {
        question: 'ما سرعة نسخ الصفقات؟',
        answer:
          'بُني مسارنا لزمن استجابة منخفض — عادة أقل من 150 مللي ثانية من تحليل الإشارة إلى إرسال الوسيط — لتصل الدخولات والتعديلات والإغلاقات إلى منصتك بينما السعر ما زال حديثًا.',
      },
      {
        question: 'كم حسابًا يمكنني ربطه؟',
        answer:
          'يمكنك ربط حتى 100 اتصال MT4/MT5 لكل مستخدم حسب خطتك. يمكن ربط كل قناة Telegram بحساب وسيط واحد أو أكثر من صفحة القنوات.',
      },
      {
        question: 'هل يقرأ UniCopier رسائلي الخاصة على Telegram؟',
        answer:
          'لا يقرأ UniCopier محادثاتك الشخصية. ربط Telegram يمنح الوصول فقط للقنوات والمجموعات التي أنت عضو فيها، ليستقبل الناسخ رسائل الإشارات من المصادر التي أضفتها.',
      },
      {
        question: 'هل يمكنني اختبار قناة قبل البث الحي؟',
        answer:
          'نعم. استخدم الاختبار التاريخي لإعادة تشغيل إشارات القناة السابقة وفق قواعد اللوت وتقسيمات TP وإعدادات النطاق والفلاتر، ثم راجع النتائج قبل تفعيل النسخ الحي.',
      },
      {
        question: 'هل تدعمون صفقات النطاق والتدرج وإشارات الإدارة؟',
        answer:
          'نعم. يدعم UniCopier الدخولات الفردية والنطاقية وتقسيم اللوت على TP متعددة وتدرج النطاق وإغلاق الدخولات الأسوأ وحركات التعادل والأرباح الجزئية وتعليمات إدارة أخرى — مع فلاتر سماح/تجاهل لكل قناة.',
      },
      {
        question: 'ماذا يشمل الأساسي والمتقدم؟',
        answer:
          'يشمل الأساسي نسخًا أساسيًا على حساب واحد مع اختبارات تاريخية وفلاتر أساسية. يضيف المتقدم نسخًا متعدد الحسابات وتدرج النطاق وميزات إدارة تلقائية وقنوات Telegram غير محدودة. راجع صفحة الأسعار للتفاصيل.',
      },
    ],
  },
  reviews: {
    title: 'ماذا يقول المتداولون',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsAr,
  },
  comparison: {
    eyebrow: 'لماذا ينتقل المستثمرون',
    title: 'ارفع مستواك مع UniCopier',
    subtitle: 'نساخ Telegram التقليديون مقابل منصة سحابية مبنية للسرعة والشفافية والتوسع.',
    otherLabel: 'نساخ آخرون',
    tscopierLabel: 'UniCopier',
    cta: 'ابدأ تجربتك المجانية لمدة 5 أيام',
    rows: [
      {
        aspect: 'الإعداد',
        other: 'إعداد صعب — يحتاج كثيرون مساعدة عملية لبدء البث الحي.',
        tscopier: 'انضمام موجّه في المتصفح؛ معظم المتداولين ينسخون خلال نحو دقيقتين.',
      },
      {
        aspect: 'لوحة التحكم',
        other: 'لوحات مزدحمة ومزدحمة تخفي ما يهم.',
        tscopier: 'لوحة تحكم واضحة تركز على القنوات والتنفيذ وصحة الحساب.',
      },
      {
        aspect: 'الإعدادات',
        other: 'أزرار ومفاتيح كثيرة — يسهل ضبطها خطأ وفقدان الثقة.',
        tscopier: 'إعدادات افتراضية ذكية مع تحكم عميق لكل قناة عندما تحتاجه فعلًا.',
      },
      {
        aspect: 'البنية التحتية',
        other: 'VPS مطلوب ليعمل EA على مدار الساعة.',
        tscopier: '100% سحابي — بلا تنزيلات، بلا EA، وبلا صيانة VPS.',
      },
      {
        aspect: 'شركات التمويل',
        other:
          'يعتمد كثير من النساخين على Expert Advisors على المنصة — محظور عندما تحظر شركة التمويل التداول الآلي.',
        tscopier:
          'تنفيذ سحابي بلا EA على الحساب — يعمل مع جميع شركات التمويل، سواء سُمح بـ EA أم لا.',
      },
      {
        aspect: 'التنفيذ',
        other: 'تنفيذ بطيء بعد وصول إشارة Telegram.',
        tscopier: 'مسار أقل من 150 مللي ثانية من التحليل إلى إرسال الوسيط.',
      },
      {
        aspect: 'حدود الحسابات',
        other: 'غالبًا محدود بـ 3–4 حسابات متصلة.',
        tscopier: 'حتى 100 اتصال MT4/MT5 لكل مستخدم.',
      },
      {
        aspect: 'الأسعار',
        other: 'مستويات معقدة وإضافات وحدود مفاجئة.',
        tscopier: 'خطط بسيطة تتضمن ميزات الناسخ الأساسية.',
      },
      {
        aspect: 'إدارة الصفقات',
        other: 'لا يزال التدخل اليدوي ضروريًا للتعديلات والجزئية والإغلاق.',
        tscopier: 'دخولات آلية وتدرج نطاق وحركات SL/TP وإشارات إدارة.',
      },
      {
        aspect: 'المنصة',
        other: 'ميزات أساسية تُباع كمنتجات أو ترقيات منفصلة.',
        tscopier: 'الناسخ والاختبار التاريخي والسجلات والأخبار والتقويم في اشتراك واحد.',
      },
      {
        aspect: 'دمج الصفقات',
        other:
          '«اشترِ الذهب الآن» يفتح صفقات، ثم «اشترِ الذهب الآن» مع SL/TP يفتح مجددًا — تضاعف أو تصلح يدويًا.',
        tscopier:
          '«اشترِ الذهب الآن» يفتح صفقة. عندما تأتي SL وTP في الرسالة التالية، نحدّث تلك الصفقات — بلا إعادة فتح الذهب.',
      },
      {
        aspect: 'الرسائل المحرّرة',
        other: 'تُتجاهل رسائل Telegram المحرّرة — تفوّت تحديثات SL/TP أو تصلح الصفقات يدويًا.',
        tscopier:
          'تعديل الإشارة من الرسائل المحرّرة يزامن وقف الخسارة وجني الأرباح عبر السلة المفتوحة — بلا صفقات جديدة.',
      },
      {
        aspect: 'الاختبار التاريخي',
        other: 'قليل أو لا يوجد إعادة تشغيل حقيقية لتاريخ القناة وفق قواعدك.',
        tscopier: 'اختبر الإشارات السابقة بإعدادات النسخ الفعلية قبل البث الحي.',
      },
    ],
  },
  pricing: {
    title: 'اختر خطتك',
    subtitle: 'ابدأ نسخ الإشارات إلى حسابات التداول اليوم.',
  },
  planComparison: {
    eyebrow: 'قارن الخطط',
    title: 'اعثر على الخطة المناسبة',
    subtitle: 'اطّلع عن كثب على ما تتضمنه كل خطة.',
    basicColumn: 'أساسي',
    advancedColumn: 'متقدم',
    customColumn: 'مخصص',
    rows: [
      {
        feature: 'حسابات الوسيط',
        basic: '1',
        advanced: '5 (حتى 100)',
        custom: 'مخصص',
      },
      {
        feature: 'اختبارات تاريخية للإشارات',
        basic: '5 / شهر',
        advanced: 'غير محدود',
        custom: 'مخصص',
      },
      {
        feature: 'قنوات Telegram',
        basic: '5',
        advanced: 'غير محدود',
        custom: 'مخصص',
      },
      {
        feature: 'مستويات جني الأرباح',
        basic: '3 TP',
        advanced: 'TP/SL غير محدود',
        custom: 'مخصص',
      },
      {
        feature: 'تداول النطاق وتدرجه',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'التعادل والإدارة التلقائية',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'تتبع كلمات مفتاحية القناة',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'دعم ذو أولوية',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'إعداد مخصص',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'تجربة مجانية',
        basic: 'no',
        advanced: '5 أيام',
        custom: 'مخصص',
      },
      {
        feature: 'السعر الابتدائي',
        basic: '9.99 USD / شهر',
        advanced: '39.99 USD / شهر',
        custom: 'اتصل بنا',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'أسئلة الأسعار الشائعة',
    title: 'أسئلة حول الأسعار',
    subtitle: 'توضيح الفوترة والتجارب وتغييرات الخطط.',
    items: [
      {
        question: 'هل توجد تجربة مجانية؟',
        answer:
          'نعم. يتضمن Advanced تجربة مجانية لمدة 5 أيام للمشتركين الجدد (يلزم إدخال البطاقة عند الدفع؛ وتبدأ الفوترة بعد انتهاء التجربة). يُحاسب Basic من اليوم الأول.',
      },
      {
        question: 'ما الفرق بين الفوترة الشهرية والسنوية؟',
        answer:
          'الفوترة السنوية توفر 20% مقارنة بالدفع الشهري طوال العام. ينخفض الأساسي من 9.99 USD شهريًا إلى 7.99 USD شهريًا (95.90 USD سنويًا). ينخفض المتقدم من 39.99 USD شهريًا إلى 31.99 USD شهريًا (383.90 USD سنويًا). الحسابات الإضافية في المتقدم تحصل أيضًا على خصم عند الفوترة السنوية.',
      },
      {
        question: 'كيف تعمل الحسابات الإضافية في المتقدم؟',
        answer:
          'يتضمن المتقدم 5 حسابات وسيط/تجريبية حية. يمكنك إضافة حتى 95 حسابًا إضافيًا بسعر 10 USD/حساب/شهر (أو 96 USD/حساب/سنة عند الفوترة السنوية)، أي حتى 100 حساب متصل لكل مستخدم.',
      },
      {
        question: 'هل يمكنني تغيير الخطة لاحقًا؟',
        answer:
          'نعم. رقِّ أو خفّض في أي وقت من صفحة الفوترة في لوحة التحكم. تسري التغييرات وفق دورة الفوترة، ويتولى Stripe التناسب عند التبديل بين الخطط.',
      },
      {
        question: 'ما طرق الدفع المقبولة؟',
        answer:
          'نقبل بطاقات الائتمان والخصم الرئيسية عبر Stripe. يمكن تنزيل الفواتير وسجل المدفوعات من صفحة الفوترة.',
      },
      {
        question: 'متى أختار المخصص؟',
        answer:
          'المخصص مخصص لشركات التمويل وفرق التداول والمشغلين ذوي الحجم الكبير الذين يحتاجون حدود حسابات أو فوترة أو إعدادًا مخصصًا لسير عملهم. تواصل مع المبيعات لنصمم الخطة المناسبة.',
      },
      {
        question: 'هل يمكنني الإلغاء في أي وقت؟',
        answer:
          'نعم. ألغِ من منطقة الفوترة أو بوابة عميل Stripe. تحتفظ بالوصول حتى نهاية فترة الفوترة الحالية. لا عقود طويلة الأجل في الأساسي والمتقدم.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} متداول اشتركوا اليوم',
    purchaseToast: 'متداول من {country} اشترى للتو خطة {plan}.',
    timeAgoJustNow: 'الآن',
    timeAgoOneMinute: 'منذ دقيقة واحدة',
  },
  pricingSnippet: {
    basic: 'أساسي — 9.99 USD/شهر',
    advanced: 'Advanced — 39.99$/شهر',
  },
  footer: {
    cta: {
      title: 'مستعد لنسخ الإشارات دون عمل يدوي؟',
      subtitle:
        'اربط Telegram، وصِل MT4 أو MT5، وابدأ النسخ خلال دقائق — بلا VPS، بلا تثبيت.',
      primary: 'ابدأ تجربتك المجانية لمدة 5 أيام',
      secondary: 'تسجيل الدخول',
    },
    tagline: 'ناسخ إشارات Telegram فائق السرعة لحسابات MetaTrader.',
    columns: {
      product: 'المنتج',
      resources: 'الموارد',
      account: 'الحساب',
    },
    links: {
      overview: 'نظرة عامة',
      features: 'الميزات',
      pricing: 'الأسعار',
      howItWorks: 'كيف يعمل',
      faq: 'الأسئلة الشائعة',
      docs: 'التوثيق',
      status: 'حالة النظام',
      telegram: 'دعم Telegram',
      riskDisclaimer: 'إخلاء مسؤولية المخاطر',
      termsOfService: 'شروط الخدمة',
      privacyPolicy: 'سياسة الخصوصية',
      cookiePolicy: 'سياسة ملفات تعريف الارتباط',
      signIn: 'تسجيل الدخول',
      signUp: 'إنشاء حساب',
      openApp: 'فتح لوحة التحكم',
    },
    platforms: 'يعمل مع',
    copyright: '© {year} Tartarix Inc. جميع الحقوق محفوظة.',
    disclaimer:
      'التداول ينطوي على مخاطر. UniCopier أداة نسخ وليس نصيحة مالية.',
  },
}
