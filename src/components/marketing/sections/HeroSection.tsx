import clsx from 'clsx'
import { ArrowRight, Megaphone } from 'lucide-react'
import { Link } from 'react-router-dom'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { ContainerScroll } from '../../ui/container-scroll-animation'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'
import { useLandingAnnouncement } from '../../../hooks/useLandingAnnouncement'
import type { LandingAnnouncement } from '../../../lib/landingAnnouncement'

/** Soft grain matching the app’s ash rail — subtle, not a green glow. */
const ASH_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.56 0 0 0 0 0.58 0 0 0 0.45 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const TAG_CLASS =
  'inline-flex items-center gap-2 rounded-full border border-neutral-300/70 bg-white/70 px-4 py-1.5 text-xs font-medium text-neutral-800 shadow-xs backdrop-blur-sm dark:border-white/10 dark:bg-white/5 dark:text-neutral-100 sm:text-sm'

function AnnouncementTag({ announcement }: { announcement: LandingAnnouncement }) {
  const content = (
    <>
      <Megaphone className="h-4 w-4 shrink-0 text-green-500 dark:text-green-400" aria-hidden />
      {announcement.message}
      {announcement.linkHref ? <ArrowRight className="h-3.5 w-3.5" aria-hidden /> : null}
    </>
  )
  const href = announcement.linkHref
  if (!href) return <div className={TAG_CLASS}>{content}</div>
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={announcement.linkLabel ?? undefined}
        className={clsx(TAG_CLASS, 'transition-colors hover:bg-white dark:hover:bg-white/10')}
      >
        {content}
      </a>
    )
  }
  return (
    <Link
      to={href}
      aria-label={announcement.linkLabel ?? undefined}
      className={clsx(TAG_CLASS, 'transition-colors hover:bg-white dark:hover:bg-white/10')}
    >
      {content}
    </Link>
  )
}

export function HeroSection() {
  const l = useT().landing
  const announcement = useLandingAnnouncement()

  // -mt-16 / pt-16 runs the ash hero under the floating nav.
  return (
    <section
      id="product"
      className={clsx(
        'relative -mt-16 scroll-mt-20 overflow-hidden pt-16',
        // Ash rail tone (#ECEEF2) with canvas fallback in dark mode.
        'bg-[#ECEEF2] dark:bg-neutral-900',
      )}
    >
      {/* Soft depth — same family as APP_CANVAS / APP_RAIL, no green swirl. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(90% 70% at 50% -10%, rgba(255,255,255,0.75), transparent 58%), radial-gradient(70% 50% at 100% 30%, rgba(244,245,247,0.9), transparent 55%), radial-gradient(60% 45% at 0% 80%, rgba(236,238,242,0.95), transparent 50%)',
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07] mix-blend-multiply dark:opacity-[0.12] dark:mix-blend-soft-light"
        style={{ backgroundImage: ASH_NOISE, backgroundSize: '160px 160px' }}
        aria-hidden
      />

      <div className="relative">
        <ContainerScroll
          titleComponent={
            <div className="mx-auto max-w-4xl text-center">
              {announcement ? (
                <div className="mb-6 flex justify-center">
                  <AnnouncementTag announcement={announcement} />
                </div>
              ) : null}

              <h1 className="text-4xl font-semibold tracking-tighter text-neutral-900 dark:text-neutral-50 sm:text-6xl lg:text-[clamp(4.5rem,7vh,5rem)] lg:leading-[1.05]">
                {l.hero.headline}
              </h1>

              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-neutral-600 dark:text-neutral-300 sm:text-lg">
                {l.hero.subheadline}
              </p>

              <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                <MarketingAuthCta variant="heroInline" />
                <a
                  href="#how-it-works"
                  className="inline-flex items-center justify-center rounded-full border border-neutral-300/80 bg-white px-6 py-3 text-sm font-semibold text-neutral-900 shadow-xs transition-colors hover:bg-neutral-50 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-50 dark:hover:bg-neutral-700 sm:px-7 sm:py-3.5 sm:text-base"
                >
                  {l.hero.secondaryCta}
                </a>
              </div>

              <MarketingPricingHint
                basic={l.pricingSnippet.basic}
                advanced={l.pricingSnippet.advanced}
                className="mt-4 text-center text-[0.6875rem] leading-relaxed text-neutral-500 dark:text-neutral-400"
              />
            </div>
          }
        >
          <HeroDashboardPreview />
        </ContainerScroll>
      </div>
    </section>
  )
}
