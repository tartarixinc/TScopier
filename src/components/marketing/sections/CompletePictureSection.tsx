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

/** Fractal-noise grain (tiled inline SVG) laid over the dark surface. */
const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const LOGO_CIRCLE =
  'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/90 ring-2 ring-white/20'

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
    <section className="relative isolate overflow-hidden bg-[#151a21]" aria-labelledby="complete-picture-title">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.02] mix-blend-screen"
        style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
        aria-hidden
      />
      <div className="mx-auto max-w-[80rem] px-3 py-12 sm:px-8 sm:py-20">
        <div className="grid items-center gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12">
          <div className="lg:ps-6">
            <p className="inline-flex items-center gap-2  text-xs font-medium uppercase tracking-[0.18em] text-green-400">
              <span className="h-2 w-2 bg-green-400" aria-hidden />
              {c.eyebrow}
            </p>
            <h2
              id="complete-picture-title"
              className="mt-5 max-w-md text-3xl font-semibold tracking-tighter text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]"
            >
              {c.title}
            </h2>
            <p className="mt-5 max-w-sm text-base leading-relaxed text-neutral-300">
              {c.description}
            </p>
          </div>

          <ul className="grid gap-4 sm:grid-cols-2" role="list">
            {c.cards.map((card, index) => (
              <li
                key={card.title}
                className="flex min-h-[13rem] flex-col rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl"
              >
                {icons[index]}
                <h3 className="mt-auto pt-8 text-lg font-semibold leading-snug tracking-tight text-white">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">
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
