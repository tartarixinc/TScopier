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
  'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/80 ring-2 ring-white/40'

function LogoStack({ logos }: { logos: readonly { name: string; src: string }[] }) {
  return (
    <div className="flex items-center" aria-hidden>
      {logos.map((logo, index) => (
        <span key={logo.name} className={`${LOGO_CIRCLE} ${index === 0 ? '' : '-ms-4'}`}>
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
      <Sparkles className="h-6 w-6" />
    </IconBubble>,
  ]

  return (
    <section className="relative isolate overflow-hidden bg-green-400" aria-labelledby="complete-picture-title">
      {/* Soft light and depth behind the glass cards. */}
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/50 blur-3xl" />
        <div className="absolute -bottom-32 left-1/3 h-96 w-[28rem] rounded-full bg-emerald-600/40 blur-3xl" />
      </div>
      <div className="mx-auto max-w-[80rem] px-3 py-12 sm:px-8 sm:py-20">
        <div className="grid items-center gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12">
          <div className="lg:ps-6">
            <p className="text-base font-medium text-neutral-950">{c.eyebrow}</p>
            <h2
              id="complete-picture-title"
              className="mt-5 max-w-md text-3xl font-semibold tracking-tighter text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]"
            >
              {c.title}
            </h2>
            <p className="mt-5 max-w-sm text-base leading-relaxed text-neutral-900/80">
              {c.description}
            </p>
          </div>

          <ul className="grid gap-4 sm:grid-cols-2" role="list">
            {c.cards.map((card, index) => (
              <li
                key={card.title}
                className="flex min-h-[13rem] flex-col rounded-3xl border border-white/50 bg-white/25 p-6 shadow-[0_8px_32px_rgba(0,80,40,0.15),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-xl"
              >
                {icons[index]}
                <h3 className="mt-auto pt-8 text-lg font-semibold leading-snug tracking-tight text-neutral-950">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-900/75">
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
