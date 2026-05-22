import type { LandingTranslations } from './types'

export const landingEs: LandingTranslations = {
  nav: {
    product: 'Producto',
    features: 'Funciones',
    pricing: 'Precios',
    signIn: 'Iniciar sesión',
    getStarted: 'Empezar',
    menuOpen: 'Abrir menú',
    menuClose: 'Cerrar menú',
  },
  hero: {
    trustedBy: 'Con la confianza de más de 30.000 traders de 156 países',
    avatarAlts: ['Avatar de trader', 'Avatar de trader', 'Avatar de trader'],
    headline: 'Copiador de señales de Telegram ultrarrápido',
    headlineAccent: 'Impulsado por IA.',
    subheadline:
      'Conecta tu cuenta MT4/MT5, elige canales de señales y deja que TSCopier ejecute entradas, capas y gestión — con control total del riesgo y filtros.',
    primaryCta: 'Empezar gratis',
    secondaryCta: 'Iniciar sesión',
    imageAlt:
      'Panel de TSCopier con saldo, beneficio diario, resultados de operaciones y gráficos de crecimiento',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: 'En 5 cuentas conectadas',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: 'vs ayer +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8 ganadas · 4 perdidas',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: 'De 2 cuentas',
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
          message: 'Canal Gold Signals Pro · listener conectado',
          time: '22 may, 09:36',
        },
        {
          message: 'Analizado BUY XAUUSD · 2 TPs desde Gold Signals Pro',
          time: '22 may, 09:37',
        },
        {
          message: 'Orden enviada a MT5 · cuenta #88291',
          time: '22 may, 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '22 may, 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '22 may, 09:35',
        },
        {
          status: 'executed',
          channel: 'Indices Daily',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '22 may, 09:31',
        },
      ],
    },
  },
  whyChoose: {
    title: '¿Por qué elegir TSCopier?',
    subtitle:
      'Tres razones por las que los traders dejan la copia manual y los EA locales por un copiador en la nube pensado para la velocidad.',
    items: [
      {
        title: 'Ejecución rápida',
        description:
          'Las señales se analizan y envían a tu broker en segundos, no en minutos. Nuestro worker en la nube usa un pipeline de baja latencia para que entradas, modificaciones y cierres de Telegram lleguen a MT4/MT5 con precio aún relevante—y los logs del copiador muestran cuándo se ejecutó cada acción.',
      },
      {
        title: 'Sin descargas',
        description:
          'TSCopier es 100 % en la nube. Sin EA que instalar, sin VPS que alquilar ni scripts del terminal que actualizar tras cada build. Inicia sesión desde el navegador, conecta tu cuenta y gestiona canales desde un solo panel—tu configuración se sincroniza sola.',
      },
      {
        title: 'Configuración en 2 minutos',
        description:
          'Crea tu cuenta, enlaza Telegram y conecta MT4 o MT5 con pasos guiados. La mayoría de traders copia su primer canal en unos dos minutos—sin expertos en cableado, errores de compilación ni montar un VPS el fin de semana.',
      },
    ],
  },
  features: {
    eyebrow: 'Funciones de la plataforma',
    title: 'Hecho para copiar señales en serio',
    subtitle:
      'Todo lo que necesitas para automatizar Telegram sin perder el control, con los mismos flujos que usas en la app.',
    showcases: [
      {
        eyebrow: 'Copiador de señales',
        title: 'Copia señales de Telegram a MT4 y MT5 con precisión',
        description:
          'Refleja canales de confianza en tus cuentas de broker. TSCopier analiza entradas, TPs, capas de rango e instrucciones de gestión, y ejecuta con tus reglas de lote, multi-trade y capas en cada cuenta conectada.',
        visual: 'copier',
      },
      {
        eyebrow: 'Control por canal',
        title: 'Filtros y reglas por palabra clave',
        description:
          'Permite o bloquea tipos de instrucción por canal: cierres, break-even, ajustes SL/TP y más. Solo las señales que quieres llegan al broker.',
        visual: 'filters',
      },
      {
        eyebrow: 'Backtest',
        title: 'Reproduce el historial antes de ir en vivo',
        description:
          'Ejecuta señales pasadas con tu configuración manual y ve cómo habría operado el copiador. Valida el análisis y la lógica sin arriesgar capital.',
        visual: 'backtest',
      },
      {
        eyebrow: 'Logs del copiador',
        title: 'Transparencia total en cada ejecución',
        description:
          'Ve qué analizó, planificó y envió el worker, con marcas de tiempo en milisegundos para depurar canales y verificar fills en tiempo real.',
        visual: 'logs',
      },
      {
        eyebrow: 'Herramientas de mercado',
        title: 'Noticias y calendario económico integrados',
        description:
          'Sigue eventos de alto impacto y titulares seleccionados desde el mismo panel, con bloqueo opcional alrededor de noticias.',
        visual: 'news',
      },
      {
        eyebrow: 'Integraciones',
        title: 'Funciona con las plataformas que ya usas',
        description:
          'Conecta canales de Telegram y copia a cuentas MetaTrader que ya gestionas, sin EA local ni scripts en VPS.',
        visual: 'integrations',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'Canal de señales',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 señales nuevas · ahora',
        hubLabel: 'TSCopier',
        mt4Label: 'Cuenta MT4',
        mt4Meta: 'Copiando · reglas 0.10 lot',
        mt5Label: 'Cuenta MT5',
        mt5Meta: 'Copiando · multi-TP',
        pillLayering: 'Capas de rango',
        pillLots: 'Tamaño de lote',
        pillChannels: 'Canales en vivo',
      },
      filters: {
        allowLabel: 'Permitir',
        ignoreLabel: 'Ignorar',
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
        resultsTitle: 'Resultados del backtest',
        resultsSubtitle: 'XAUUSD · Canal',
        newRunLabel: 'Nueva ejecución',
        totalPipsLabel: 'Pips totales',
        totalPips: '+544.0p',
        winRateLabel: 'Tasa de acierto',
        winRate: '67%',
        winLossLabel: 'G / P',
        winLoss: '16/8',
        signalsLabel: 'Señales',
        signalsCount: '24',
        signalsListLabel: '24 señales',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: 'Todos los TP',
            pips: '+62.0p',
            pipsTone: 'good',
            duration: '23m',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL tocado',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1h 12m',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: 'Parcial',
            pips: '+24.5p',
            pipsTone: 'good',
            duration: '45m',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '22 may, 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '22 may, 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '22 may, 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '22 may, 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '22 may, 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '22 may, 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '22 may, 19:48' },
        ],
      },
      news: {
        calendarTitle: 'Calendario económico',
        impactHigh: 'Alto',
        impactMed: 'Med',
        pillCalendar: 'Bloqueo por noticias',
        events: [
          { name: 'Nóminas no agrícolas EE.UU.', time: 'Hoy · 13:30 UTC', impact: 'high' },
          { name: 'Decisión BCE', time: 'Jue · 12:15 UTC', impact: 'high' },
          { name: 'IPC Reino Unido', time: 'Vie · 07:00 UTC', impact: 'med' },
        ],
        headlines: [
          { label: 'El oro sigue al alza' },
          { label: 'EUR/USD rompe 1.10' },
          { label: 'BTC supera $70k' },
        ],
      },
      integrations: {
        hubLabel: 'TSCopier',
        labels: { telegram: 'Telegram', mt4: 'MT4', mt5: 'MT5' },
      },
    },
  },
  steps: {
    title: 'Cómo funciona',
    subtitle: 'Del canal de Telegram al broker en tres pasos.',
    items: [
      {
        title: 'Conectar Telegram',
        description: 'Enlaza los canales que confías. Solo los marcados alimentan tu broker.',
      },
      {
        title: 'Configurar el broker',
        description: 'Lote, TPs, capas, filtros y auto-gestión por cuenta.',
      },
      {
        title: 'Copiar señales',
        description: 'TSCopier analiza, planifica y envía órdenes — tú supervisas desde el panel.',
      },
    ],
  },
  reviews: {
    title: 'Confianza de traders',
    trustpilotLabel: 'Trustpilot',
    items: [
      {
        quote:
          'TSCopier redujo mi copia manual casi a cero. Las señales llegan a MT5 en segundos.',
        author: 'Rob Flemming',
      },
      {
        quote:
          'Panel claro, análisis fiable y logs fáciles de depurar.',
        author: 'Sarah Mitchell',
      },
      {
        quote:
          'Capas en rango y cierre de peores entradas — copio con tranquilidad.',
        author: 'Eloise Laurent',
      },
    ],
  },
  pricing: {
    title: 'Precios simples',
    subtitle: 'Empieza con Basic o desbloquea estrategias avanzadas con Advanced.',
    perMonth: '/mes',
    popular: 'Más popular',
    viewPlans: 'Ver todos los planes',
    basic: {
      name: 'Basic',
      description: 'Una cuenta, modo single-trade, backtests y filtros básicos.',
      priceLabel: '$9.99',
      cta: 'Empezar con Basic',
    },
    advanced: {
      name: 'Advanced',
      description: 'Varias cuentas, capas en rango, auto-gestión, canales ilimitados.',
      priceLabel: '$39.99',
      cta: 'Prueba 10 días',
    },
  },
  footer: {
    copyright: '© {year} Tartarix Inc.',
    docs: 'Documentación',
    status: 'Estado',
    openApp: 'Abrir app',
  },
}
