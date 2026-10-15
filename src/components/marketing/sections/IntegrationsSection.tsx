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

function Heading({ title, highlight }: { title: string; highlight: string }) {
  const at = highlight ? title.indexOf(highlight) : -1
  if (at === -1) return <>{title}</>
  return (
    <>
      {title.slice(0, at)}
      <span className="text-green-400 dark:text-green-400">{highlight}</span>
      {title.slice(at + highlight.length)}
    </>
  )
}

export function IntegrationsSection() {
  const copy = useT().landing.integrations

  return (
    <section className="mx-auto max-w-6xl px-5 pb-4 pt-12 sm:px-8 sm:pt-16" aria-labelledby="integrations-title">
      <h2
        id="integrations-title"
        className="mx-auto max-w-2xl text-center text-3xl font-bold tracking-tighter text-neutral-900 dark:text-neutral-50 sm:text-4xl lg:text-5xl lg:leading-[1.1]"
      >
        <Heading title={copy.title} highlight={copy.highlight} />
      </h2>

      <ul className="mt-10 flex flex-col items-center sm:mt-14" role="list">
        {INTEGRATION_ROWS.map((row, rowIndex) => (
          <li key={rowIndex} className={rowIndex === 0 ? undefined : '-mt-[clamp(0.9rem,3.4vw,1.95rem)]'}>
            <ul className="flex items-center justify-center" role="list">
              {row.map(logo => (
                <li
                  key={logo.name}
                  className="flex aspect-square w-[clamp(3.5rem,13vw,7.5rem)] items-center justify-center rounded-full bg-neutral-50 ring-4 ring-white transition-transform duration-200 hover:scale-105 sm:ring-[6px] dark:bg-neutral-800 dark:ring-neutral-900"
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
    </section>
  )
}
