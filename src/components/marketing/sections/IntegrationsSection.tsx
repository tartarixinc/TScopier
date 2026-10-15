import { useT } from '../../../context/LocaleContext'

type IntegrationLogo = { name: string; src: string }

/**
 * Two rows of five. Each circle carries a ring in the page colour and later circles paint on top,
 * so overlapping circles read as cut out of one another.
 * Signal sources first, then the brokers and exchanges we trade on.
 */
const INTEGRATION_ROWS: readonly (readonly IntegrationLogo[])[] = [
  [
    { name: 'Telegram', src: '/Telegram.svg' },
    { name: 'Discord', src: '/discord-logo.png' },
    { name: 'WhatsApp', src: '/whatsapp-icon.png' },
    { name: 'TradingView', src: '/tradingview-logo.png' },
    { name: 'MetaTrader 4', src: '/MT4.png' },
  ],
  [
    { name: 'MetaTrader 5', src: '/MT5.png' },
    { name: 'cTrader', src: '/cTrader.png' },
    { name: 'Binance', src: '/Binance.png' },
    { name: 'Bybit', src: '/Bybit.png' },
    { name: 'KuCoin', src: '/Kucoin.png' },
  ],
]

/** Fractal-noise grain as an inline SVG, tiled. */
const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function IntegrationsSection() {
  const copy = useT().landing.integrations

  return (
    <section className="relative isolate overflow-hidden bg-neutral-950" aria-labelledby="integrations-title">
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_70%_at_50%_0%,rgba(74,222,128,0.10),transparent_70%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-10 opacity-[0.22] mix-blend-screen"
        style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
        aria-hidden
      />
      <div className="relative mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-green-400 dark:text-green-400">
            {copy.eyebrow}
          </p>
          <h2
            id="integrations-title"
            className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl"
          >
            {copy.title}
          </h2>
        </div>

        <ul className="mt-10 flex flex-col items-center sm:mt-14" role="list">
          {INTEGRATION_ROWS.map((row, rowIndex) => (
            <li key={rowIndex} className={rowIndex === 0 ? undefined : '-mt-[clamp(0.9rem,3.4vw,1.95rem)]'}>
              <ul className="flex items-center justify-center" role="list">
                {row.map(logo => (
                  <li
                    key={logo.name}
                    className="flex aspect-square w-[clamp(3.5rem,13vw,7.5rem)] items-center justify-center rounded-full bg-neutral-50 ring-4 ring-neutral-950 transition-transform duration-200 hover:scale-105 sm:ring-[6px]"
                  >
                    <img
                      src={logo.src}
                      alt={logo.name}
                      title={logo.name}
                      loading="lazy"
                      draggable={false}
                      className="h-[52%] w-[52%] object-contain"
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
