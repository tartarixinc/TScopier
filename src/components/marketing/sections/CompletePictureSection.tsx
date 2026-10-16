import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../../../context/LocaleContext'

const SOURCE_LOGOS = [
  { name: 'WhatsApp', src: '/whatsapp-icon.png' },
  { name: 'Discord', src: '/discord-logo.png' },
  { name: 'Telegram', src: '/Telegram.svg' },
] as const

const PLATFORM_LOGOS = [
  { name: 'MetaTrader 4', src: '/MT4.png' },
  { name: 'MetaTrader 5', src: '/MT5.png' },
  { name: 'cTrader', src: '/cTrader.png' },
  { name: 'Binance', src: '/Binance.png' },
  { name: 'Bybit', src: '/Bybit.png' },
  { name: 'KuCoin', src: '/Kucoin.png' },
] as const

const LOGO_CIRCLE =
  'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 ring-2 ring-white dark:bg-neutral-100 dark:ring-neutral-900'

function LogoStack({ logos }: { logos: readonly { name: string; src: string }[] }) {
  return (
    <div className="flex items-center" aria-hidden>
      {logos.map((logo, index) => (
        <span key={logo.name} className={`${LOGO_CIRCLE} ${index === 0 ? '' : '-ms-2.5'}`}>
          <img src={logo.src} alt="" draggable={false} className="h-[58%] w-[58%] object-contain" />
        </span>
      ))}
    </div>
  )
}

function IconBubble({ children }: { children: ReactNode }) {
  return (
    <span className={`${LOGO_CIRCLE} text-neutral-900`} aria-hidden>
      {children}
    </span>
  )
}

export function CompletePictureSection() {
  const c = useT().landing.completePicture

  const icons: ReactNode[] = [
    <LogoStack key="sources" logos={SOURCE_LOGOS} />,
    <LogoStack key="platforms" logos={PLATFORM_LOGOS} />,
    <LogoStack key="tradingview" logos={[{ name: 'TradingView', src: '/tradingview-logo.png' }]} />,
    <IconBubble key="ai">
      <Sparkles className="h-4 w-4" />
    </IconBubble>,
  ]

  return (
    <section className="relative" aria-labelledby="complete-picture-title">
      <div className="mx-auto max-w-[80rem] px-3 py-6 sm:px-8 sm:py-10">
        <div className="grid items-center gap-8 rounded-[2rem] bg-neutral-100 p-5 sm:rounded-[2.5rem] sm:p-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12 lg:p-12 dark:bg-white/[0.05] dark:ring-1 dark:ring-white/10">
          <div className="lg:ps-6">
            <p className="text-base font-medium text-neutral-900 dark:text-neutral-50">{c.eyebrow}</p>
            <h2
              id="complete-picture-title"
              className="mt-5 max-w-md text-3xl font-semibold tracking-tighter text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08] dark:text-white"
            >
              {c.title}
            </h2>
            <p className="mt-5 max-w-sm text-base leading-relaxed text-neutral-700 dark:text-neutral-300">
              {c.description}
            </p>
          </div>

          <ul className="grid gap-4 sm:grid-cols-2" role="list">
            {c.cards.map((card, index) => (
              <li
                key={card.title}
                className="flex min-h-[13rem] flex-col rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:bg-neutral-900 dark:ring-1 dark:ring-white/10"
              >
                {icons[index]}
                <h3 className="mt-auto pt-8 text-lg font-semibold leading-snug tracking-tight text-neutral-950 dark:text-white">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
                  {card.description}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
