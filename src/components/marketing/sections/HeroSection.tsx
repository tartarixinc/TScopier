import clsx from 'clsx'
import { ArrowRight, Megaphone } from 'lucide-react'
import { Link } from 'react-router-dom'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import AnimatedGradient, { type GradientConfig } from '../../ui/animated-gradient'
import { ContainerScroll } from '../../ui/container-scroll-animation'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'
import { useLandingAnnouncement } from '../../../hooks/useLandingAnnouncement'
import type { LandingAnnouncement } from '../../../lib/landingAnnouncement'

/** Fractal-noise grain (tiled inline SVG) laid over the dark hero card. */
const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/**
 * Slow green swirl behind the hero (module-level so the config identity is stable).
 * Kept dark enough for the white headline; `bg-green-900` on the section is the no-WebGL fallback.
 */
const HERO_GRADIENT: GradientConfig = {
  preset: 'custom',
  color1: '#052e16',
  color2: '#14532d',
  color3: '#16a34a',
  rotation: 40,
  proportion: 38,
  scale: 0.6,
  speed: 12,
  distortion: 8,
  swirl: 45,
  swirlIterations: 6,
  softness: 100,
  offset: 0,
  shape: 'Checks',
  shapeSize: 40,
}

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
    <section id="product" className="relative -mt-16 scroll-mt-20 overflow-hidden bg-green-900 pt-16">
      {/* z-index 0 (not the component's default -1): the section has no stacking context, so -1 would hide it behind bg-green-900. */}
      <AnimatedGradient config={HERO_GRADIENT} style={{ zIndex: 0 }} />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.09] mix-blend-screen"
        style={{ backgroundImage: NOISE_BG, backgroundSize: '140px 140px' }}
        aria-hidden
      />

      <div className="relative">
        <ContainerScroll
          titleComponent={
            <div className="text-center lg:text-left">
              {announcement ? (
                <div className="mb-6 flex justify-center lg:justify-start">
                  <AnnouncementTag announcement={announcement} />
                </div>
              ) : null}

              <div className="grid items-start gap-8 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
                <h1 className="mx-auto max-w-xl text-4xl font-bold tracking-tight text-white sm:text-5xl lg:mx-0 lg:text-[clamp(3.25rem,6vh,4.5rem)] lg:leading-[1.05]">
                  {l.hero.headline}
                </h1>

                <div className="lg:pt-2">
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-neutral-200 sm:text-base lg:mx-0">
                    {l.hero.subheadline}
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
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
                    className="mt-4 text-center text-[0.6875rem] leading-relaxed text-green-100/80 lg:text-left"
                  />
                </div>
              </div>
            </div>
          }
        >
          <HeroDashboardPreview />
        </ContainerScroll>
      </div>
    </section>
  )
}
