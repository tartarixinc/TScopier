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
      <div className="mx-auto max-w-[80rem] px-5 py-10 sm:px-10 sm:py-12 lg:px-14">
        <h2
          id="supported-platforms-title"
          className="text-sm font-medium tracking-tight text-neutral-700 dark:text-neutral-300"
        >
          {title}
        </h2>

        {/* dir="ltr" keeps the right-to-left scroll the same in right-to-left languages. */}
        <div
          dir="ltr"
          className="logo-marquee mt-3 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]"
        >
          <ul className="logo-marquee-track flex items-center" role="list">
            {[...LOGOS, ...LOGOS].map((logo, index) => {
              const duplicate = index >= LOGOS.length
              return (
                <li
                  key={`${logo.name}-${index}`}
                  aria-hidden={duplicate || undefined}
                  className="shrink-0"
                >
                  {/* The files carry built-in padding, so the logo art is about half the image height. */}
                  <img
                    src={logo.src}
                    alt={duplicate ? '' : logo.name}
                    draggable={false}
                    className="h-12 w-auto max-w-none dark:rounded-xl dark:bg-white sm:h-14"
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
