import clsx from 'clsx'
import { ArrowRight, Megaphone } from 'lucide-react'
import { Link } from 'react-router-dom'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'
import { useLandingAnnouncement } from '../../../hooks/useLandingAnnouncement'
import type { LandingAnnouncement } from '../../../lib/landingAnnouncement'

/** Fractal-noise grain (tiled inline SVG) laid over the dark hero card. */
const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/** The announcement tag sits on the dark card in both themes. */
const TAG_GLASS = 'border border-white/15 bg-white/10 text-neutral-100 backdrop-blur-md'

function AnnouncementTag({ announcement }: { announcement: LandingAnnouncement }) {
  const className = clsx(
    'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium sm:text-sm',
    TAG_GLASS,
  )
  const content = (
    <>
      <Megaphone className="h-4 w-4 shrink-0 text-green-400" aria-hidden />
      {announcement.message}
      {announcement.linkHref ? <ArrowRight className="h-3.5 w-3.5" aria-hidden /> : null}
    </>
  )
  const href = announcement.linkHref
  if (!href) return <div className={className}>{content}</div>
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={announcement.linkLabel ?? undefined}
        className={clsx(className, 'transition-colors hover:bg-white/15')}
      >
        {content}
      </a>
    )
  }
  return (
    <Link
      to={href}
      aria-label={announcement.linkLabel ?? undefined}
      className={clsx(className, 'transition-colors hover:bg-white/15')}
    >
      {content}
    </Link>
  )
}

export function HeroSection() {
  const l = useT().landing
  const announcement = useLandingAnnouncement()

  // -mt-16 / pt-16 runs the dark hero under the (transparent) floating nav, to the top of the page.
  return (
    <section
      id="product"
      className="relative -mt-16 scroll-mt-20 overflow-hidden bg-[#151a21] pt-16 lg:h-[100svh] lg:min-h-[37.5rem]"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.2] mix-blend-screen"
        style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-[80rem] flex-col px-6 pt-12 sm:px-12 sm:pt-16 lg:h-full lg:px-16 lg:pt-[clamp(2.5rem,7vh,4.5rem)]">
        {announcement ? (
          <div className="mb-6 lg:mb-[clamp(0.75rem,2.5vh,1.5rem)]">
            <AnnouncementTag announcement={announcement} />
          </div>
        ) : null}

        <div className="grid items-start gap-8 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
          <h1 className="max-w-xl text-4xl font-semibold tracking-tighter text-white sm:text-5xl lg:text-[clamp(2.25rem,6vh,3.5rem)] lg:leading-[1.05]">
            {l.hero.headline}
          </h1>

          <div className="lg:pt-2">
            <p className="max-w-md text-sm leading-relaxed text-neutral-200 sm:text-base">
              {l.hero.subheadline}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3 lg:mt-[clamp(0.875rem,2.5vh,1.5rem)]">
              <MarketingAuthCta variant="heroInline" />
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center rounded-full bg-neutral-300 px-6 py-3 text-sm font-semibold text-neutral-900 transition-colors hover:bg-white sm:px-7 sm:py-3.5 sm:text-base"
              >
                {l.hero.secondaryCta}
              </a>
            </div>
            <MarketingPricingHint
              basic={l.pricingSnippet.basic}
              advanced={l.pricingSnippet.advanced}
              className="mt-4 text-[0.6875rem] leading-relaxed text-neutral-400"
            />
          </div>
        </div>

        {/* The product screenshot is cropped by the bottom edge of the hero. */}
        <div className="mx-auto mt-10 max-h-[20rem] w-full max-w-5xl overflow-hidden rounded-t-[1.25rem] bg-white text-left shadow-[0_-12px_60px_-10px_rgba(74,222,128,0.18)] ring-1 ring-white/10 sm:mt-14 sm:max-h-[26rem] sm:rounded-t-[1.75rem] lg:mt-[clamp(1rem,3.5vh,2.5rem)] lg:max-h-none lg:min-h-0 lg:flex-1">
          <HeroDashboardPreview />
        </div>
      </div>
    </section>
  )
}
