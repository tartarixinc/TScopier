import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowRight, Copy, Link2, Users, type LucideIcon } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import { appUrl } from '../../../lib/site'
import { TradingAccountPreview } from '../preview/TradingAccountPreview'
import { MirrorAccountPreview } from '../preview/MirrorAccountPreview'
import { SocialTradingPreview } from '../preview/SocialTradingPreview'

const CARD_BG = '#10151c'

const NOISE_BG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")"

type CardEntry = {
  key: 'tradingAccount' | 'mirrorAccount' | 'socialTrading'
  icon: LucideIcon
  href: string
  preview: ReactNode
}

const CARDS: readonly CardEntry[] = [
  { key: 'tradingAccount', icon: Link2, href: appUrl('/brokers'), preview: <TradingAccountPreview /> },
  { key: 'mirrorAccount', icon: Copy, href: appUrl('/mirror-trading'), preview: <MirrorAccountPreview /> },
  { key: 'socialTrading', icon: Users, href: appUrl('/social-trading'), preview: <SocialTradingPreview /> },
]

export function ProductShowcaseSection() {
  const t = useT()
  const s = t.landing.showcase
  const [active, setActive] = useState(0)

  const labels: Record<CardEntry['key'], string> = {
    tradingAccount: t.pages.accountConfiguration.title,
    mirrorAccount: t.mirrorTradingPage.title,
    socialTrading: t.socialTradingPage.title,
  }

  return (
    <section
      id="showcase"
      className="relative scroll-mt-24 bg-[#F4F5F8] py-16 sm:py-24 dark:bg-transparent"
    >
      <div className="mx-auto max-w-[80rem] px-3 sm:px-5">
        <div className="px-2 sm:px-6">
          <p className="inline-flex items-center gap-2  text-xs font-medium uppercase tracking-[0.18em] text-neutral-900 dark:text-neutral-50">
            <span className="h-2 w-2 bg-green-400" aria-hidden />
            {s.eyebrow}
          </p>
          <h2 className="mt-5 max-w-3xl text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1] dark:text-white">
            {s.title}
          </h2>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {CARDS.map((card, index) => {
            const Icon = card.icon
            const copy = s.cards[index]
            const open = active === index
            return (
              <article
                key={card.key}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                className="group relative isolate flex h-[36rem] flex-col justify-end overflow-hidden rounded-[2rem] ring-1 ring-black/5 dark:ring-white/10"
                style={{ backgroundColor: CARD_BG }}
              >
                <div
                  className="absolute -top-24 left-1/2 h-72 w-[130%] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
                  style={{ background: 'radial-gradient(closest-side, rgba(74,222,128,0.35), transparent)' }}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute inset-0 z-[1] opacity-[0.07] mix-blend-screen"
                  style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
                  aria-hidden
                />

                <div className="absolute left-[38%] top-[10%] w-[150%]">{card.preview}</div>

                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[55%]"
                  style={{
                    background: `linear-gradient(to top, ${CARD_BG} 0%, ${CARD_BG} 30%, rgba(16,21,28,0.85) 58%, rgba(16,21,28,0) 100%)`,
                  }}
                  aria-hidden
                />

                <div className="relative z-[3] p-7">
                  <p className="inline-flex items-center gap-2  text-xs font-medium uppercase tracking-[0.16em] text-green-400">
                    <Icon className="h-4 w-4" aria-hidden />
                    {labels[card.key]}
                  </p>
                  <h3 className="mt-3 text-xl font-semibold leading-snug tracking-tight text-white">
                    {copy.headline}
                  </h3>
                  <div
                    className={clsx(
                      'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
                      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[1fr] opacity-100 lg:grid-rows-[0fr] lg:opacity-0',
                    )}
                  >
                    <div className="overflow-hidden">
                      <p className="pt-2 text-sm leading-6 text-neutral-300">{copy.description}</p>
                    </div>
                  </div>
                  <a
                    href={card.href}
                    className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
                  >
                    {s.cta}
                    <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
                  </a>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
