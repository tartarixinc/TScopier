import { useT } from '../../../context/LocaleContext'

type IntegrationLogo = { name: string; src: string }

/** Two rows of five. Signal sources first, then the brokers and exchanges we trade on. */
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
          <li key={rowIndex} className={rowIndex === 0 ? undefined : '-mt-3 sm:-mt-5 lg:-mt-6'}>
            <ul className="flex items-center justify-center -space-x-2 sm:-space-x-3 lg:-space-x-4" role="list">
              {row.map(logo => (
                <li
                  key={logo.name}
                  className="flex aspect-square w-[clamp(4.25rem,17vw,10rem)] items-center justify-center rounded-full bg-neutral-50 ring-1 ring-neutral-100 transition-transform duration-200 hover:z-10 hover:scale-105 dark:bg-neutral-800/60 dark:ring-neutral-800"
                >
                  <img
                    src={logo.src}
                    alt={logo.name}
                    title={logo.name}
                    loading="lazy"
                    draggable={false}
                    className="h-[56%] w-[56%] object-contain"
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
