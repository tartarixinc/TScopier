import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import clsx from 'clsx'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'

function RotatingHeroPhrase({ phrases }: { phrases: string[] }) {
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState(true)

  useEffect(() => {
    if (phrases.length < 2) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let fadeTimer = 0
    const timer = window.setInterval(() => {
      if (reduceMotion) {
        setIndex(current => (current + 1) % phrases.length)
        return
      }
      setShown(false)
      fadeTimer = window.setTimeout(() => {
        setIndex(current => (current + 1) % phrases.length)
        setShown(true)
      }, 220)
    }, 2600)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(fadeTimer)
    }
  }, [phrases])

  return (
    <span className="mt-2 block min-h-[1.15em] text-teal-600 dark:text-teal-400" aria-live="polite">
      <span
        className={clsx(
          'inline-block transition-all duration-200',
          shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        )}
      >
        {phrases[index]}
      </span>
    </span>
  )
}

export function HeroSection() {
  const l = useT().landing

  return (
    <section
      id="product"
      className="relative -mt-[4.75rem] scroll-mt-28 overflow-hidden bg-white pt-[4.75rem] dark:bg-transparent sm:-mt-20 sm:pt-20"
    >
      <div className="marketing-hero-grid" aria-hidden />
      <div className="relative z-[1] mx-auto max-w-6xl px-5 pb-4 pt-6 sm:px-8 sm:pt-8 sm:pb-8 lg:max-w-7xl lg:pt-10">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-5xl font-bold tracking-tighter text-neutral-900 dark:text-neutral-50 sm:text-5xl xl:text-[3.5rem] xl:leading-[1.08]">
            {l.hero.headline}
            {l.hero.headlinePhrases && l.hero.headlinePhrases.length > 0 ? (
              <RotatingHeroPhrase phrases={l.hero.headlinePhrases} />
            ) : null}
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
        </div>

        <div className="hero-product-showcase relative mx-auto mt-6 w-full max-w-5xl sm:mt-8 lg:mt-10 lg:max-w-7xl">
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
