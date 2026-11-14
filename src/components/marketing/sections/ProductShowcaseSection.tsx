import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowRight, Copy, Link2, Users, type LucideIcon } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import { APP_CANVAS, APP_CARD } from '../../../lib/appSurface'
import { appUrl } from '../../../lib/site'
import { TradingAccountPreview } from '../preview/TradingAccountPreview'
import { MirrorAccountPreview } from '../preview/MirrorAccountPreview'
import { SocialTradingPreview } from '../preview/SocialTradingPreview'
import { ScrollReveal } from '../ScrollReveal'

/** Soft grain matching the app ash rail. */
const ASH_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.56 0 0 0 0 0.58 0 0 0 0.45 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

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
    <section id="showcase" className={clsx('relative scroll-mt-24 py-16 sm:py-24', APP_CANVAS)}>
      <div className="mx-auto max-w-7xl px-3 sm:px-5">
        <ScrollReveal className="px-2 sm:px-6">
          <p className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-neutral-900 dark:text-neutral-50">
            <span className="h-2 w-2 bg-green-400" aria-hidden />
            {s.eyebrow}
          </p>
          <h2 className="mt-5 max-w-3xl text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1] dark:text-white">
            {s.title}
          </h2>
        </ScrollReveal>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {CARDS.map((card, index) => {
            const Icon = card.icon
            const copy = s.cards[index]
            const open = active === index
            return (
              <ScrollReveal key={card.key} delay={0.06 * index}>
              <article
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                className={clsx(
                  'group relative isolate flex h-144 flex-col justify-end overflow-hidden rounded-[1.75rem]',
                  APP_CARD,
                  'bg-[#ECEEF2] shadow-[0_1px_2px_rgba(15,23,42,0.05),0_16px_40px_-20px_rgba(15,23,42,0.2)] dark:bg-neutral-900',
                )}
              >
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-multiply dark:opacity-[0.1] dark:mix-blend-soft-light"
                  style={{ backgroundImage: ASH_NOISE, backgroundSize: '160px 160px' }}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute -top-20 left-1/2 h-64 w-[120%] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
                  style={{
                    background: 'radial-gradient(closest-side, rgba(255,255,255,0.9), transparent)',
                  }}
                  aria-hidden
                />

                <div className="absolute left-[32%] top-[8%] w-[155%]">{card.preview}</div>

                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-2 h-[58%]"
                  style={{
                    background:
                      'linear-gradient(to top, #ECEEF2 0%, #ECEEF2 28%, rgba(236,238,242,0.92) 52%, rgba(236,238,242,0) 100%)',
                  }}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-2 hidden h-[58%] dark:block"
                  style={{
                    background:
                      'linear-gradient(to top, rgb(23,23,23) 0%, rgb(23,23,23) 28%, rgba(23,23,23,0.92) 52%, rgba(23,23,23,0) 100%)',
                  }}
                  aria-hidden
                />

                <div className="relative z-3 p-7">
                  <p className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-neutral-600 dark:text-neutral-300">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-400 text-neutral-950">
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    {labels[card.key]}
                  </p>
                  <h3 className="mt-3 text-xl font-semibold leading-snug tracking-tight text-neutral-950 dark:text-white">
                    {copy.headline}
                  </h3>
                  <div
                    className={clsx(
                      'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
                      open
                        ? 'grid-rows-[1fr] opacity-100'
                        : 'grid-rows-[1fr] opacity-100 lg:grid-rows-[0fr] lg:opacity-0',
                    )}
                  >
                    <div className="overflow-hidden">
                      <p className="pt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                        {copy.description}
                      </p>
                    </div>
                  </div>
                  <a
                    href={card.href}
                    className="mt-5 inline-flex items-center gap-2 rounded-full bg-neutral-950 px-5 py-2.5 text-sm font-medium text-white shadow-xs transition-colors hover:bg-neutral-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-100"
                  >
                    {s.cta}
                    <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
                  </a>
                </div>
              </article>
              </ScrollReveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}
