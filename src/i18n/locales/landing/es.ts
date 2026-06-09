import { testimonialsEs } from '../../testimonials/es'
import type { LandingTranslations } from './types'

export const landingEs: LandingTranslations = {
  nav: {
    product: 'Producto',
    features: 'Funciones',
    pricing: 'Precios',
    faq: 'FAQ',
    docs: 'Docs',
    signIn: 'Iniciar sesión',
    getStarted: 'Empezar',
    dashboard: 'Panel',
    menuOpen: 'Abrir menú',
    menuClose: 'Cerrar menú',
  },
  hero: {
    trustedBy: 'Más de 30.000 traders de 156 países ya se han unido',
    avatarAlts: ['Avatar de trader', 'Avatar de trader', 'Avatar de trader'],
    headline: 'Convierte las señales de Telegram en operaciones en vivo,',
    headlineAccent: '100 % en piloto automático.',
    subheadline:
      'Conecta tu cuenta MT4/MT5, elige canales de señales y deja que TSCopier ejecute entradas, capas y gestión — con control total del riesgo y filtros.',
    primaryCta: 'Pruébalo gratis',
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
    eyebrow: 'La copia inteligente empieza con herramientas inteligentes',
    title:
      'Cada función de TScopier está pensada para darte control, claridad y resultados medibles.',
    cards: [
      {
        label: 'Velocidad de ejecución',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'Latencia inferior a 150 ms desde el parseo de la señal hasta el broker.',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'Plataforma en la nube',
        metric: '100%',
        metricVariant: 'teal',
        description:
          '100 % en la nube: sin descargas, sin EA y sin VPS. Todo desde el navegador.',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'Escala de brokers',
        metric: '100',
        metricVariant: 'neutral',
        description: 'Hasta 100 conexiones MT5/MT4 por usuario.',
        layout: 'short',
        icon: 'link',
      },
      {
        label: 'Operaciones',
        metric: '24/7',
        metricVariant: 'teal',
        description: 'Operaciones 24/7 sin vigilar un equipo local.',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'Motor de copia',
        metric: 'Avanzado',
        metricVariant: 'teal',
        description:
          'Estrategia de copia avanzada: plantillas, filtros, backtest y reglas por canal.',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: 'Fiabilidad',
        metric: '99,99%',
        metricVariant: 'teal',
        description: '99,99 % de uptime para copiar cuando el mercado se mueve.',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'Controles de riesgo',
        metric: 'Capas',
        metricVariant: 'neutral',
        description: 'Layering y cierre de entradas peores en rangos y multi-TP.',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: 'Modos de trade',
        metric: 'Single y Range',
        metricVariant: 'neutral',
        description: 'Trading single y range con reglas de lote compartidas.',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: 'Telegram',
        metric: 'Ilimitado',
        metricVariant: 'teal',
        description: 'Canales y grupos de Telegram ilimitados.',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'Backtest',
        metric: 'Replay',
        metricVariant: 'teal',
        description: 'Reproduce el historial del canal con tus reglas antes de arriesgar capital real.',
        layout: 'short',
        icon: 'history',
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
    ],
    visuals: {
      copier: {
        telegramLabel: 'Canal de señales',
        channelName: 'Gold Signals Pro',
        channelMeta: '3 señales nuevas · ahora',
        hubLabel: 'TScopier',
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
        dayHeading: 'Jueves, 21 de mayo',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'Tasa de inflación interanual (abr)',
            impact: 'high',
            actual: '1,40%',
            forecast: '1,80%',
            previous: '2,00%',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: 'Decisión de tipos del BoJ',
            impact: 'high',
            actual: '0,50%',
            forecast: '0,50%',
            previous: '0,25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: 'Solicitudes iniciales de desempleo',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'PMI manufacturero S&P Global (may)',
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
              'Oro (XAUUSD), plata y platino: el oro retrocede mientras los operadores se inquietan...',
            source: 'fxempire.com',
            relativeTime: 'hace 10 h',
          },
          {
            headline: 'EUR/USD: los alcistas del euro necesitan un dólar más débil para romper 1,10',
            source: 'fxstreet.com',
            relativeTime: 'hace 12 h',
          },
          {
            headline: 'USD/JPY se mantiene cerca de máximos con los diferenciales de tipos',
            source: 'investing.com',
            relativeTime: 'hace 14 h',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: 'Primeros pasos',
    title: 'Cómo funciona',
    subtitle: 'Del canal de Telegram al broker en tres pasos, con las mismas pantallas de la app.',
    items: [
      {
        title: 'Conectar Telegram',
        description:
          'Enlaza tu cuenta de Telegram, elige canales de señales y conéctalos a las cuentas MT4/MT5 que deben copiar.',
        visual: 'telegram',
      },
      {
        title: 'Configurar el broker',
        description:
          'Define lote, reparto de TPs, reglas de rango y filtros permitir/ignorar por canal en cada cuenta.',
        visual: 'configure',
      },
      {
        title: 'Copiar señales',
        description:
          'El channel worker analiza cada mensaje; los logs del copiador muestran cada ejecución en tiempo real.',
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
        rangeLabel: 'Capas en rango',
        rangeValue: '50 % · 3 pips',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'Señales de cierre', decision: 'allow' },
          { label: 'Modificar SL / TP', decision: 'allow' },
          { label: 'Movimientos a BE', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Analizado BUY XAUUSD · 2 TPs de Gold Signals Pro',
            time: '22 may, 09:37',
          },
          {
            message: 'Enviado 0,10 lot a MT5 · cuenta #88291',
            time: '22 may, 09:37',
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
    eyebrow: 'Preguntas frecuentes',
    title: 'Preguntas frecuentes',
    subtitle: 'Respuestas rápidas sobre configuración, copia y qué hace diferente a TSCopier.',
    items: [
      {
        question: '¿Necesito descargar un EA o un VPS?',
        answer:
          'No. TScopier es 100 % en la nube. Inicias sesión en el navegador, conectas Telegram y tus cuentas MT4/MT5, y el copiador corre en nuestra infraestructura—sin EA ni VPS que mantener.',
      },
      {
        question: '¿Qué plataformas admite TScopier?',
        answer:
          'Conectas canales de señales de Telegram y copias a cuentas MetaTrader 4 y 5. Enlaza varios brokers y dirige cada canal a las cuentas que elijas.',
      },
      {
        question: '¿Qué tan rápido se copian las operaciones?',
        answer:
          'Nuestro pipeline está optimizado para baja latencia—normalmente menos de 150 ms del parseo al envío al broker—para que entradas, modificaciones y cierres lleguen con precio aún relevante.',
      },
      {
        question: '¿Cuántas cuentas puedo conectar?',
        answer:
          'Puedes vincular hasta 100 conexiones MT4/MT5 por usuario, según tu plan. Cada canal de Telegram puede conectarse a una o más cuentas desde la página de Canales.',
      },
      {
        question: '¿TScopier lee mis mensajes privados de Telegram?',
        answer:
          'TScopier no lee tus chats personales. Conectar Telegram solo da acceso a canales y grupos de los que eres miembro para recibir señales de las fuentes que añades.',
      },
      {
        question: '¿Puedo probar un canal antes de ir en vivo?',
        answer:
          'Sí. Usa Backtest para reproducir señales pasadas con tus reglas de lote, TPs, rango y filtros—y revisa los resultados antes de activar la copia en vivo.',
      },
      {
        question: '¿Admitís rangos, capas y señales de gestión?',
        answer:
          'Sí. TScopier gestiona entradas single y range, reparto de lotes en varios TPs, layering, cierre de entradas peores, break-even, beneficios parciales y más, con filtros permitir/ignorar por canal.',
      },
      {
        question: '¿Qué incluye Basic frente a Advanced?',
        answer:
          'Basic cubre la copia principal en una cuenta con backtests y filtros esenciales. Advanced añade multi-cuenta, capas en rango, auto-gestión y canales ilimitados. Consulta Precios para el detalle actual.',
      },
    ],
  },
  reviews: {
    title: 'Lo que dicen los traders',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsEs,
  },
  comparison: {
    eyebrow: 'Por qué cambian de copiador',
    title: 'Sube de nivel con TScopier',
    subtitle:
      'Copiadores típicos de Telegram frente a una plataforma en la nube pensada para velocidad, claridad y escala.',
    otherLabel: 'Otros copiadores',
    tscopierLabel: 'TScopier',
    cta: 'Empezar gratis',
    rows: [
      {
        aspect: 'Puesta en marcha',
        other: 'Difícil de poner en marcha; muchos usuarios dependen del soporte para arrancar.',
        tscopier: 'Onboarding guiado en el navegador; la mayoría copia en unos dos minutos.',
      },
      {
        aspect: 'Panel',
        other: 'Paneles abarrotados que ocultan lo importante.',
        tscopier: 'Un panel limpio centrado en canales, ejecución y salud de cuentas.',
      },
      {
        aspect: 'Opciones',
        other: 'Demasiadas opciones: fácil equivocarse y perder confianza.',
        tscopier: 'Valores sensatos por defecto y control profundo por canal cuando lo necesitas.',
      },
      {
        aspect: 'Infraestructura',
        other: 'Hace falta un VPS para mantener los EA activos 24/7.',
        tscopier: '100 % en la nube: sin descarga, sin EA y sin VPS que mantener.',
      },
      {
        aspect: 'Ejecución',
        other: 'Ejecución lenta después de que llega la señal a Telegram.',
        tscopier: 'Pipeline de menos de 150 ms del parseo al envío al broker.',
      },
      {
        aspect: 'Límite de cuentas',
        other: 'A menudo limitado a 3–4 cuentas vinculadas.',
        tscopier: 'Hasta 100 conexiones MT4/MT5 por usuario.',
      },
      {
        aspect: 'Precios',
        other: 'Planes complejos, complementos y límites ocultos.',
        tscopier: 'Planes claros con las funciones principales del copiador incluidas.',
      },
      {
        aspect: 'Gestión de trades',
        other: 'Sigue haciendo falta intervenir manualmente en modificaciones y cierres.',
        tscopier: 'Entradas, capas, movimientos de SL/TP y gestión automatizados.',
      },
      {
        aspect: 'Plataforma',
        other: 'Funciones clave vendidas como productos o upgrades aparte.',
        tscopier: 'Copiador, backtest, logs, noticias y calendario en una suscripción.',
      },
      {
        aspect: 'Backtest',
        other: 'Poco o ningún replay real del historial del canal con tus reglas.',
        tscopier: 'Backtest de señales pasadas con tu configuración real antes de ir en vivo.',
      },
    ],
  },
  pricing: {
    title: 'Elige tu plan',
    subtitle: 'Comienza a copiar señales a tus cuentas de trading hoy.',
  },
  planComparison: {
    eyebrow: 'Comparar planes',
    title: 'Encuentra el plan ideal',
    subtitle: 'Comparación lado a lado de lo que incluye cada plan.',
    basicColumn: 'Basic',
    advancedColumn: 'Advanced',
    customColumn: 'Personalizado',
    rows: [
      {
        feature: 'Cuentas de broker',
        basic: '1',
        advanced: '5 (hasta 100)',
        custom: 'Personalizado',
      },
      {
        feature: 'Backtests de señales',
        basic: '5 / mes',
        advanced: 'Ilimitados',
        custom: 'Personalizado',
      },
      {
        feature: 'Canales de Telegram',
        basic: '5',
        advanced: 'Ilimitados',
        custom: 'Personalizado',
      },
      {
        feature: 'Niveles de take profit',
        basic: '3 TPs',
        advanced: 'TPs/SLs ilimitados',
        custom: 'Personalizado',
      },
      {
        feature: 'Trading en rango y layering',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Breakeven y gestión automática',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Seguimiento por palabras clave',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'Soporte prioritario',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Onboarding dedicado',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: 'Prueba gratuita',
        basic: 'no',
        advanced: '10 días',
        custom: 'Personalizado',
      },
      {
        feature: 'Precio inicial',
        basic: '9,99 $ / mes',
        advanced: '39,99 $ / mes',
        custom: 'Contáctanos',
      },
    ],
  },
  pricingFaq: {
    eyebrow: 'FAQ de precios',
    title: 'Preguntas sobre precios',
    subtitle: 'Facturación, pruebas y cambios de plan explicados.',
    items: [
      {
        question: '¿Hay prueba gratuita?',
        answer:
          'Advanced incluye 10 días de prueba gratuita al suscribirte. Basic se factura desde el primer día a 9,99 $/mes (o 95,90 $/año con facturación anual). Puedes explorar el panel antes de suscribirte, pero la copia en vivo requiere un plan activo.',
      },
      {
        question: '¿Cuál es la diferencia entre facturación mensual y anual?',
        answer:
          'La facturación anual ahorra un 20 % frente a pagar mes a mes durante un año. Basic baja de 9,99 $/mes a 7,99 $/mes efectivos (95,90 $/año). Advanced baja de 39,99 $/mes a 31,99 $/mes efectivos (383,90 $/año). Las cuentas extra en Advanced también tienen descuento anual.',
      },
      {
        question: '¿Cómo funcionan las cuentas extra en Advanced?',
        answer:
          'Advanced incluye 5 cuentas demo/en vivo. Puedes añadir hasta 95 más a 10 $/cuenta/mes (o 96 $/cuenta/año con facturación anual), hasta un máximo de 100 cuentas conectadas por usuario.',
      },
      {
        question: '¿Puedo cambiar de plan más tarde?',
        answer:
          'Sí. Mejora o reduce tu plan en cualquier momento desde Facturación en tu panel. Los cambios se aplican según tu ciclo de facturación y Stripe gestiona la prorrateo al cambiar de plan.',
      },
      {
        question: '¿Qué métodos de pago aceptáis?',
        answer:
          'Aceptamos las principales tarjetas de crédito y débito a través de Stripe. Las facturas e historial de pagos están disponibles en tu página de Facturación.',
      },
      {
        question: '¿Cuándo debería elegir Personalizado?',
        answer:
          'Personalizado es para firmas prop, equipos de trading u operadores de alto volumen que necesitan límites, facturación u onboarding adaptados. Contacta con ventas y prepararemos un plan a medida.',
      },
      {
        question: '¿Puedo cancelar en cualquier momento?',
        answer:
          'Sí. Cancela desde Facturación o el portal de cliente de Stripe. Mantienes el acceso hasta el final del periodo de facturación actual. No hay contratos a largo plazo en Basic o Advanced.',
      },
    ],
  },
  pricingSocialProof: {
    banner: '{count} traders compraron hoy',
    purchaseToast: 'Un trader de {country} acaba de comprar la suscripción {plan}.',
    timeAgoJustNow: 'Ahora mismo',
    timeAgoOneMinute: 'Hace 1 minuto',
  },
  pricingSnippet: {
    basic: 'Basic — 9,99 $/mes',
    advanced: 'Advanced — 10 días gratis, luego 39,99 $/mes',
  },
  footer: {
    cta: {
      title: '¿Listo para copiar señales sin trabajo manual?',
      subtitle:
        'Conecta Telegram, enlaza MT4 o MT5 y empieza a copiar en minutos — sin VPS ni instalación.',
      primary: 'Pruébalo gratis',
      secondary: 'Iniciar sesión',
    },
    tagline: 'Copiador de señales de Telegram ultrarrápido para cuentas MetaTrader.',
    columns: {
      product: 'Producto',
      resources: 'Recursos',
      account: 'Cuenta',
    },
    links: {
      overview: 'Resumen',
      features: 'Funciones',
      pricing: 'Precios',
      howItWorks: 'Cómo funciona',
      faq: 'Preguntas frecuentes',
    docs: 'Documentación',
      status: 'Estado del sistema',
      telegram: 'Soporte en Telegram',
      riskDisclaimer: 'Aviso de riesgo',
      termsOfService: 'Términos de servicio',
      privacyPolicy: 'Política de privacidad',
      cookiePolicy: 'Política de cookies',
      signIn: 'Iniciar sesión',
      signUp: 'Crear cuenta',
      openApp: 'Abrir panel',
    },
    platforms: 'Compatible con',
    copyright: '© {year} Tartarix Inc. Todos los derechos reservados.',
    disclaimer:
      'Operar implica riesgo. TScopier es una herramienta de copia — no asesoramiento financiero.',
  },
}
