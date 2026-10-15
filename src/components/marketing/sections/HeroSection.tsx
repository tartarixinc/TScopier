import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { useT } from '../../../context/LocaleContext'

const GLASS =
  'border border-white/70 bg-white/55 shadow-[0_8px_32px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]'

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
    <span className="mt-1 block min-h-[1.2em] pb-1" aria-live="polite">
      <span
        className={clsx(
          'inline-block bg-gradient-to-r from-green-400 via-emerald-500 to-cyan-400 bg-clip-text text-transparent transition-all duration-200',
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
    <section id="product" className="relative scroll-mt-20 overflow-hidden bg-white dark:bg-transparent">
      {/* Aurora + faint grid. Only decoration, the glass surfaces below pick the colour up. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="marketing-hero-grid [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)]" />
        <div className="hero-aurora-blob absolute -top-32 left-1/2 h-[26rem] w-[40rem] -translate-x-[70%] rounded-full bg-green-300/45 blur-3xl dark:bg-green-400/20" />
        <div
          className="hero-aurora-blob absolute -top-16 left-1/2 h-[24rem] w-[34rem] translate-x-[5%] rounded-full bg-cyan-200/50 blur-3xl dark:bg-cyan-400/15"
          style={{ animationDelay: '-6s' }}
        />
        <div
          className="hero-aurora-blob absolute top-[28rem] left-1/2 h-[22rem] w-[44rem] -translate-x-1/2 rounded-full bg-emerald-200/40 blur-3xl dark:bg-emerald-400/10"
          style={{ animationDelay: '-11s' }}
        />
      </div>

      <div className="relative z-[1] mx-auto flex max-w-6xl flex-col items-center px-5 pb-16 pt-14 text-center sm:px-8 sm:pt-20 lg:pb-24">
        {l.hero.socialProof ? (
          <div className={clsx('inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium text-neutral-800 dark:text-neutral-100 sm:text-sm', GLASS)}>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            {l.hero.socialProof}
          </div>
        ) : null}

        <h1 className="mt-6 max-w-4xl text-4xl font-semibold tracking-tighter text-neutral-950 dark:text-neutral-50 sm:text-6xl lg:text-7xl lg:leading-[1.04]">
          {l.hero.headline}
          {l.hero.headlinePhrases && l.hero.headlinePhrases.length > 0 ? (
            <RotatingHeroPhrase phrases={l.hero.headlinePhrases} />
          ) : null}
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-neutral-700 dark:text-neutral-300 sm:text-lg">
          {l.hero.subheadline}
        </p>

        <div className="mt-9 flex flex-col items-center">
          <MarketingAuthCta variant="hero" />
          <MarketingPricingHint
            basic={l.pricingSnippet.basic}
            advanced={l.pricingSnippet.advanced}
            className="mt-4 text-center text-[0.6875rem] leading-relaxed text-neutral-600 dark:text-neutral-400"
          />
        </div>

        <div className="relative mt-14 w-full max-w-5xl sm:mt-20">
          {/* Frosted frame around the product, fading out at the bottom. */}
          <div
            className={clsx(
              'relative overflow-hidden rounded-[1.75rem] p-2 text-left shadow-[0_40px_90px_-30px_rgba(16,185,129,0.45)] sm:rounded-[2.25rem] sm:p-3',
              GLASS,
            )}
          >
            <div className="max-h-[22rem] overflow-hidden rounded-[1.25rem] bg-white shadow-sm dark:bg-neutral-950 sm:max-h-[30rem] sm:rounded-[1.75rem] lg:max-h-[36rem]">
              <HeroDashboardPreview />
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-white/90 to-transparent dark:from-neutral-950/80"
              aria-hidden
            />
          </div>
        </div>
      </div>
    </section>
  )
}
