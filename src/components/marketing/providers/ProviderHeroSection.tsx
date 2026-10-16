import clsx from 'clsx'
import { ArrowUpRight, TrendingUp } from 'lucide-react'
import { Grain, ProviderCta } from './shared'
import { initials, useProviderPage } from './helpers'

const GLASS = 'border border-white/10 bg-white/[0.06] backdrop-blur-xl shadow-[0_24px_60px_-24px_rgba(0,0,0,0.8)]'
const BAR_HEIGHTS = [38, 52, 44, 70, 62, 84, 76] as const
const COPIERS = ['Amira Hassan', 'Leo Berg', 'Nora Okonkwo', 'Kenji Sato'] as const

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={clsx(
        'flex h-8 w-8 items-center justify-center rounded-full bg-green-200 text-[0.6875rem] font-semibold text-neutral-950 ring-2 ring-black',
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

/** Floating sample dashboard: earnings, copiers and recent activity. */
function ProviderEarningsPreview() {
  const v = useProviderPage().hero.visual

  return (
    <div className="relative mx-auto flex w-full max-w-lg flex-col gap-4 lg:max-w-none" dir="ltr">
      <div className={clsx('rounded-3xl p-5 sm:p-6 lg:me-14', GLASS)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-400">
              {v.monthlyEarnings}
            </p>
            <p className="mt-2 text-4xl font-bold tracking-tight text-white sm:text-5xl">$4,280</p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden />
              +18.4% {v.vsLastMonth}
            </p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[0.625rem] uppercase tracking-wider text-neutral-400">
            {v.sampleBadge}
          </span>
        </div>
        <div className="mt-6" aria-hidden>
          <div className="flex h-24 items-end gap-2 sm:h-28">
            {BAR_HEIGHTS.map((height, index) => (
              <div
                key={index}
                className={clsx(
                  'flex-1 rounded-md',
                  index === BAR_HEIGHTS.length - 2 ? 'bg-green-400' : 'bg-green-400/30',
                )}
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            {BAR_HEIGHTS.map((_, index) => (
              <span key={index} className="flex-1 text-center text-[0.625rem] text-neutral-500">
                {v.weekdays[index]}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-4 lg:ms-12 lg:-mt-4">
        <div className={clsx('rounded-3xl p-5', GLASS)}>
          <p className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-400">
            {v.activeCopiers}
          </p>
          <div className="mt-2 flex items-end justify-between gap-3">
            <p className="text-3xl font-bold tracking-tight text-white">86</p>
            <div className="flex -space-x-2">
              {COPIERS.map(name => (
                <Avatar key={name} name={name} />
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col justify-between rounded-3xl bg-green-400 p-5 text-neutral-950 shadow-[0_24px_60px_-24px_rgba(74,222,128,0.6)]">
          <p className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-950/70">
            {v.priceSet}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight">$50</p>
        </div>
      </div>

      <div className={clsx('rounded-3xl p-5 lg:me-6 lg:-mt-4', GLASS)}>
        <p className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-400">
          {v.recentActivity}
        </p>
        <ul className="mt-3 space-y-3" role="list">
          {[
            { name: 'Nora Okonkwo', text: v.newCopier, time: v.justNow },
            { name: 'Kenji Sato', text: v.copyRequest, time: v.minutesAgo.replace('{count}', '12') },
          ].map(row => (
            <li key={row.name} className="flex items-center gap-3">
              <Avatar name={row.name} className="h-9 w-9 text-xs" />
              <p className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                <span className="font-semibold text-white">{row.name}</span> {row.text}
              </p>
              <span className="shrink-0 text-xs text-neutral-500">{row.time}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function ProviderHeroSection() {
  const c = useProviderPage().hero

  return (
    <section
      className="relative -mt-16 overflow-hidden pt-16 text-white"
      style={{ backgroundColor: '#000' }}
    >
      <Grain className="opacity-[0.16]" />

      <div className="relative mx-auto max-w-[80rem] px-5 pb-12 pt-16 sm:px-8 sm:pt-20 lg:px-14 lg:pb-16 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-10">
          <div>
            <p className="inline-flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-green-400">
              <span className="h-2 w-2 bg-green-400" aria-hidden />
              {c.eyebrow}
            </p>
            <h1 className="mt-5 max-w-xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-[clamp(3rem,5.4vh,4.25rem)] lg:leading-[1.05]">
              {c.title}
            </h1>
            <p className="mt-5 max-w-lg text-sm leading-relaxed text-neutral-300 sm:text-base">{c.description}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ProviderCta label={c.primaryCta} placement="hero" />
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-white/10 px-6 py-3 text-sm font-semibold text-white ring-1 ring-white/15 transition-colors hover:bg-white/15 sm:px-7 sm:py-3.5 sm:text-base"
              >
                {c.secondaryCta}
                <ArrowUpRight className="h-4 w-4 rotate-90 rtl:-rotate-90" aria-hidden />
              </a>
            </div>
            <p className="mt-4 text-xs text-neutral-400">{c.note}</p>
          </div>

          <ProviderEarningsPreview />
        </div>

        <dl className="mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-white/10 ring-1 ring-white/10 lg:mt-20 lg:grid-cols-4">
          {c.stats.map(stat => (
            <div key={stat.value} className="bg-neutral-950 px-5 py-6 sm:px-7">
              <dt className="text-xl font-bold tracking-tight text-white sm:text-2xl">{stat.value}</dt>
              <dd className="mt-1 text-xs leading-snug text-neutral-400 sm:text-sm">{stat.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
