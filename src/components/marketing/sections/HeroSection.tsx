import { Lock } from 'lucide-react'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { HeroPlatformFlow } from '../HeroPlatformFlow'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'

const HERO_AVATARS = [
  '/marketing/hero-avatar-1.jpg',
  '/marketing/hero-avatar-2.jpg',
  '/marketing/hero-avatar-3.jpg',
] as const

export function HeroSection() {
  const l = useT().landing

  return (
    <section id="product" className="relative scroll-mt-28 overflow-hidden">
      <div className="marketing-hero-grid" aria-hidden />
      <div className="relative z-[1] mx-auto max-w-6xl px-5 pb-4 pt-6 sm:px-8 sm:pt-8 sm:pb-8 lg:pt-10">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 sm:mb-8">
            <HeroPlatformFlow />
          </div>

          <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl xl:text-[3.75rem] xl:leading-[1.08]">
            <span className="block text-neutral-900 dark:text-neutral-50">{l.hero.headline}</span>
            <span className="mt-1 block text-teal-600 dark:text-teal-400">{l.hero.headlineAccent}</span>
          </h1>

          <p className="mt-5 text-base leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-xl">
            {l.hero.subheadline}
          </p>

          <div className="mt-10 flex flex-col items-center">
            <MarketingAuthCta variant="hero" />
            <MarketingPricingHint
              basic={l.pricingSnippet.basic}
              advanced={l.pricingSnippet.advanced}
            />
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 sm:mt-10">
            <div className="flex -space-x-2.5">
              {HERO_AVATARS.map((src, i) => (
                <img
                  key={src}
                  src={src}
                  alt={l.hero.avatarAlts[i]}
                  width={36}
                  height={36}
                  className="h-6 w-6 rounded-full border-2 border-white object-cover dark:border-neutral-700"
                />
              ))}
            </div>
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {l.hero.trustedBy}
            </p>
          </div>
        </div>

        <div className="hero-product-showcase relative mx-auto mt-6 w-full max-w-5xl sm:mt-8 lg:mt-10">
          <div className="hero-product-frame">
            <div className="hero-product-chrome">
              <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
                <span className="hero-chrome-dot bg-[#FF5F57]" />
                <span className="hero-chrome-dot bg-[#FEBC2E]" />
                <span className="hero-chrome-dot bg-[#28C840]" />
              </div>
              <div className="hero-product-url">
                <Lock className="h-3 w-3 shrink-0 text-teal-600/80 dark:text-teal-400/80" aria-hidden />
                <span className="truncate">{l.hero.previewUrl}</span>
              </div>
            </div>
            <div className="hero-product-screen">
              <HeroDashboardPreview />
            </div>
          </div>

          <div className="hero-product-reflection" aria-hidden />
        </div>
      </div>
    </section>
  )
}
