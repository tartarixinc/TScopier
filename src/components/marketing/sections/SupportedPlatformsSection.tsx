import { useT } from '../../../context/LocaleContext'

/** Full wordmark logos (1865x666, transparent, with built-in padding). Signal sources first, then trading platforms. */
const LOGOS = [
  { name: 'Telegram', src: '/telegram-full.png' },
  { name: 'WhatsApp', src: '/Whatsapp-full.png' },
  { name: 'Discord', src: '/discord-full.png' },
  { name: 'TradingView', src: '/tradingview-full.png' },
  { name: 'MetaTrader 4', src: '/metatrader4-full.png' },
  { name: 'MetaTrader 5', src: '/metatrader5-full.png' },
  { name: 'cTrader', src: '/ctrader-full.png' },
  { name: 'Binance', src: '/binance-full.png' },
  { name: 'Bybit', src: '/bybit-full.png' },
  { name: 'KuCoin', src: '/kucoin-full.png' },
  { name: 'DX-Trade', src: '/dxtrade-full.png' },
  { name: 'TradeLocker', src: '/tradelocker-full.png' },
  { name: 'Match-Trader', src: '/match-trader-full.png' },
] as const

export function SupportedPlatformsSection() {
  const title = useT().landing.supportedPlatforms.title

  return (
    <section
      className="border-b border-neutral-200/70 bg-white dark:border-white/10 dark:bg-[#151a21]"
      aria-labelledby="supported-platforms-title"
    >
      <div className="mx-auto max-w-[80rem] px-3 pt-12 sm:px-8 sm:pt-16">
        <h2
          id="supported-platforms-title"
          className="text-center text-2xl font-semibold tracking-tighter text-neutral-950 sm:text-3xl dark:text-white"
        >
          {title}
        </h2>
      </div>

      <div className="mt-8 pb-12 sm:mt-10 sm:pb-16">
        {/* dir="ltr" keeps the right-to-left scroll the same in right-to-left languages. */}
        <div
          dir="ltr"
          className="logo-marquee overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]"
        >
          <ul className="logo-marquee-track flex" role="list">
            {[...LOGOS, ...LOGOS].map((logo, index) => {
              const duplicate = index >= LOGOS.length
              return (
                <li
                  key={`${logo.name}-${index}`}
                  aria-hidden={duplicate || undefined}
                  className="me-3 flex h-16 w-44 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] sm:me-4 sm:h-20 sm:w-56 dark:border-white/10"
                >
                  <img
                    src={logo.src}
                    alt={duplicate ? '' : logo.name}
                    draggable={false}
                    className="h-full w-full object-contain"
                  />
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </section>
  )
}
