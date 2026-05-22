import { ArrowRight, Lock } from 'lucide-react'
import { HeroDashboardPreview } from '../HeroDashboardPreview'
import { useT } from '../../../context/LocaleContext'
import { appUrl } from '../../../lib/site'

const HERO_AVATARS = [
  '/marketing/hero-avatar-1.jpg',
  '/marketing/hero-avatar-2.jpg',
  '/marketing/hero-avatar-3.jpg',
] as const

export function HeroSection() {
  const l = useT().landing

  return (
    <section id="product" className="relative scroll-mt-28 overflow-hidden">
      <div className="relative mx-auto max-w-6xl px-5 pb-4 pt-6 sm:px-8 sm:pt-8 sm:pb-8 lg:pt-10">
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <div className="flex -space-x-2.5">
              {HERO_AVATARS.map((src, i) => (
                <img
                  key={src}
                  src={src}
                  alt={l.hero.avatarAlts[i]}
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-full border-2 border-white object-cover dark:border-neutral-700"
                />
              ))}
            </div>
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {l.hero.trustedBy}
            </p>
          </div>

          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl xl:text-[2.5rem] xl:leading-[1.08]">
            <span className="block text-neutral-900 dark:text-neutral-50">{l.hero.headline}</span>
            <span className="mt-1 block text-teal-600 dark:text-teal-400">{l.hero.headlineAccent}</span>
          </h1>

          <p className="mt-5 text-base leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-lg">
            {l.hero.subheadline}
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={appUrl('/signup')}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-teal-600 bg-teal-600 px-7 py-3.5 text-base font-semibold text-white transition-colors hover:border-teal-700 hover:bg-teal-700 sm:w-auto"
            >
              {l.hero.primaryCta}
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </a>
            <a
              href={appUrl('/login')}
              className="inline-flex w-full items-center justify-center rounded-xl border border-neutral-200 bg-white px-7 py-3.5 text-base font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 sm:w-auto"
            >
              {l.hero.secondaryCta}
            </a>
          </div>
        </div>

        <div className="hero-product-showcase relative mx-auto mt-12 w-full max-w-5xl sm:mt-14 lg:mt-16">
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
