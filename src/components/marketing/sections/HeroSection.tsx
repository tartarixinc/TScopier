import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { MarketingAuthCta } from '../MarketingAuthCta'
import { MarketingPricingHint } from '../MarketingPricingHint'
import { SignalSourceLogo } from '../../dashboard/SignalSourceLogo'
import { useT } from '../../../context/LocaleContext'
import type { SignalSourceKind } from '../../../lib/signalSourceMark'

const HERO_SOURCE_MARKS: Array<{ pattern: RegExp; kind: SignalSourceKind }> = [
  { pattern: /^Telegram\p{L}*$/u, kind: 'telegram' },
  { pattern: /^Discord\p{L}*$/u, kind: 'discord' },
  { pattern: /^WhatsApp$/u, kind: 'whatsapp' },
  { pattern: /^TradingView$/u, kind: 'tradingview' },
]

function heroSourceKind(part: string): SignalSourceKind | null {
  return HERO_SOURCE_MARKS.find(mark => mark.pattern.test(part))?.kind ?? null
}

function HeroSubheadline({ text }: { text: string }) {
  const parts = text.split(/(Telegram\p{L}*|Discord\p{L}*|WhatsApp|TradingView)/gu)
  return (
    <>
      {parts.map((part, index) => {
        const kind = heroSourceKind(part)
        if (!kind) return <span key={index}>{part}</span>
        return (
          <span key={index} className="inline-flex items-center gap-1.5 whitespace-nowrap align-middle">
            <SignalSourceLogo kind={kind} className="h-[1.05em] w-[1.05em]" />
            {part}
          </span>
        )
      })}
    </>
  )
}

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
    <span className="mt-2 block min-h-[1.15em] text-green-400 dark:text-green-400" aria-live="polite">
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
      className="relative scroll-mt-20 overflow-hidden bg-white dark:bg-transparent"
    >
      <div className="marketing-hero-grid" aria-hidden />
      <div className="relative z-[1] mx-auto flex max-w-[90rem] flex-col items-center gap-8 px-5 pb-6 pt-12 sm:px-8 sm:pt-16 lg:flex-row lg:items-start lg:gap-8 lg:pb-10 lg:pt-20">
        <div className="w-full max-w-xl shrink-0 text-center lg:ms-12 lg:w-[34rem] lg:pt-2 lg:text-left xl:ms-20 xl:w-[38rem]">
          <h1 className="text-4xl font-bold tracking-tighter text-neutral-900 dark:text-neutral-50 sm:text-5xl xl:text-[4rem] xl:leading-[1.05]">
            {l.hero.headline}
            {l.hero.headlinePhrases && l.hero.headlinePhrases.length > 0 ? (
              <RotatingHeroPhrase phrases={l.hero.headlinePhrases} />
            ) : null}
          </h1>

          <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-neutral-900 dark:text-neutral-50 sm:text-lg lg:mx-0">
            <HeroSubheadline text={l.hero.subheadline} />
          </p>

          <div className="mt-8 flex flex-col items-center lg:items-start">
            <MarketingAuthCta variant="hero" />
            <MarketingPricingHint
              basic={l.pricingSnippet.basic}
              advanced={l.pricingSnippet.advanced}
              className="mt-3 text-center text-[0.625rem] leading-relaxed text-neutral-900 dark:text-neutral-50 lg:text-left"
            />
          </div>
        </div>

        <div className="w-full min-w-0 flex-1 lg:pt-1">
          <div className="max-h-[22rem] w-[140%] overflow-hidden rounded-[1.75rem] bg-green-400 p-2.5 sm:max-h-[26rem] sm:w-[148%] sm:p-3 lg:max-h-[30rem] lg:w-[155%]">
            <div className="mb-2 flex items-center gap-1.5 px-1" aria-hidden>
              <span className="hero-chrome-dot bg-[#FF5F57]" />
              <span className="hero-chrome-dot bg-[#FEBC2E]" />
              <span className="hero-chrome-dot bg-[#28C840]" />
            </div>
            <div className="overflow-hidden rounded-xl bg-white shadow-sm dark:bg-neutral-950">
              <HeroDashboardPreview />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
