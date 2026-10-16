import { ArrowRight, Coins, Tag, Users, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useProviderPage } from '../providers/helpers'
import { marketingUrl } from '../../../lib/site'
import { SocialTradingPreview } from '../preview/SocialTradingPreview'
import { useT } from '../../../context/LocaleContext'

const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const POINT_ICONS: readonly LucideIcon[] = [Tag, Users, Coins]

/** Pitch for signal providers: set a price, build a community, keep 100% of the profit. */
export function SellSignalsSection() {
  const p = useT().landing.providers
  const providerPage = useProviderPage()

  return (
    <section id="providers" className="mx-auto max-w-[80rem] scroll-mt-28 px-3 py-8 sm:px-5 sm:py-12">
      <article
        className="relative isolate grid overflow-hidden rounded-[2rem] ring-1 ring-black/5 lg:min-h-[34rem] lg:grid-cols-[0.95fr_1.05fr] dark:ring-white/10"
        style={{ backgroundImage: 'linear-gradient(160deg, #161d26 0%, #0c1015 75%)' }}
      >
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.1] mix-blend-screen"
          style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
          aria-hidden
        />

        <div className="flex flex-col justify-center p-7 sm:p-10 lg:p-14">
          <p className="inline-flex items-center gap-2  text-xs font-medium uppercase tracking-[0.18em] text-green-400">
            <span className="h-2 w-2 bg-green-400" aria-hidden />
            {p.eyebrow}
          </p>
          <h2 className="mt-5 max-w-lg text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
            {p.title}
          </h2>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-neutral-300 sm:text-base">
            {p.description}
          </p>

          <ul className="mt-8 space-y-4" role="list">
            {p.points.map((point, index) => {
              const Icon = POINT_ICONS[index]
              return (
                <li key={point.title} className="flex items-start gap-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-400 text-neutral-950">
                    <Icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white sm:text-base">{point.title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-neutral-400">{point.description}</p>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="mt-8">
            <Link
              to={marketingUrl('/providers')}
              className="group inline-flex items-center justify-center gap-2 rounded-full border border-green-400 bg-green-400 px-6 py-3 text-sm font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_10px_28px_-10px_rgba(74,222,128,0.7)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_24px_rgba(74,222,128,0.5)] sm:px-7 sm:py-3.5 sm:text-base"
            >
              {providerPage.landingLink}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" aria-hidden />
            </Link>
          </div>
        </div>

        <div className="relative h-[20rem] overflow-hidden sm:h-[26rem] lg:h-auto">
          <div className="absolute left-6 top-6 w-[125%] sm:left-10 sm:top-10 lg:top-14">
            <SocialTradingPreview />
          </div>
        </div>
      </article>
    </section>
  )
}
