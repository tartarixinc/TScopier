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

export function IntegrationsSection() {
  const copy = useT().landing.integrations

  return (
    <section className="relative" aria-labelledby="integrations-title">
      <div className="relative mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-green-500 dark:text-green-400">
            {copy.eyebrow}
          </p>
          <h2
            id="integrations-title"
            className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl dark:text-white"
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
                    className="flex aspect-square w-[clamp(3.5rem,13vw,7.5rem)] items-center justify-center rounded-full bg-neutral-50 shadow-[0_2px_10px_rgba(15,23,42,0.12)] ring-4 ring-white dark:shadow-none dark:ring-neutral-900 transition-transform duration-200 hover:scale-105 sm:ring-[6px]"
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
