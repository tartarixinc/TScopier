import clsx from 'clsx'
import { ArrowRight, BarChart3, Check, ShieldCheck, Tag, Users, X, Zap, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Eyebrow } from './shared'
import { initials, useProviderPage } from './helpers'

const CARD =
  'relative flex flex-col overflow-hidden rounded-[1.75rem] border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_32px_-16px_rgba(15,23,42,0.18)]'

function CardHead({
  icon: Icon,
  title,
  description,
  featured = false,
}: {
  icon: LucideIcon
  title: string
  description: string
  featured?: boolean
}) {
  return (
    <div>
      <span
        className={clsx(
          'flex h-10 w-10 items-center justify-center rounded-xl',
          featured ? 'bg-neutral-950 text-green-400' : 'bg-green-400 text-neutral-950',
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="mt-5 text-xl font-bold leading-tight tracking-tight text-neutral-950">{title}</h3>
      <p className={clsx('mt-2 text-sm leading-relaxed', featured ? 'text-neutral-950/80' : 'text-neutral-600')}>
        {description}
      </p>
    </div>
  )
}

function Mock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx('mt-6 rounded-2xl border border-neutral-200/80 bg-neutral-50 p-4', className)}
      dir="ltr"
      aria-hidden
    >
      {children}
    </div>
  )
}

function PricingMock() {
  const c = useProviderPage().toolkit.pricing
  return (
    <Mock className="mt-auto">
      <div className="flex rounded-full bg-neutral-200/70 p-1 text-sm font-medium">
        <span className="flex-1 rounded-full py-1.5 text-center text-neutral-600">{c.free}</span>
        <span className="flex-1 rounded-full bg-neutral-950 py-1.5 text-center text-white">{c.paid}</span>
      </div>
      <p className="mt-4 text-center text-3xl font-bold tracking-tight text-neutral-950">
        $50<span className="text-base font-medium text-neutral-500">{c.unit}</span>
      </p>
    </Mock>
  )
}

function AccessMock() {
  const c = useProviderPage().toolkit.access
  return (
    <Mock className="mt-auto space-y-3">
      <div className="flex rounded-full bg-neutral-200/70 p-1 text-xs font-medium">
        <span className="flex-1 rounded-full py-1.5 text-center text-neutral-600">{c.anyone}</span>
        <span className="flex-1 rounded-full bg-neutral-950 py-1.5 text-center text-white">{c.requests}</span>
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-neutral-200/80">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 text-[0.6875rem] font-semibold text-neutral-950">
          {initials('Kenji Sato')}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-neutral-950">Kenji Sato</p>
          <p className="truncate text-xs text-neutral-500">{c.requested}</p>
        </div>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-400 text-neutral-950">
          <Check className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-neutral-700">
          <X className="h-3.5 w-3.5" aria-hidden />
        </span>
      </div>
    </Mock>
  )
}

function ProfileMock() {
  const c = useProviderPage().toolkit.profile
  const stats = [
    { label: c.roi, value: '+34.2%', accent: true },
    { label: c.winRate, value: '68.0%' },
    { label: c.drawdown, value: '6.4%' },
    { label: c.closedTrades, value: '128' },
  ]
  return (
    <Mock className="mt-auto">
      <div className="grid grid-cols-2 gap-2">
        {stats.map(stat => (
          <div key={stat.label} className="rounded-xl bg-white p-3 ring-1 ring-neutral-200/80">
            <p className="truncate text-[0.625rem] font-medium uppercase tracking-wide text-neutral-500">
              {stat.label}
            </p>
            <p
              className={clsx(
                'mt-1 text-lg font-bold tracking-tight',
                stat.accent ? 'text-green-600' : 'text-neutral-950',
              )}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </Mock>
  )
}

function CommunityMock() {
  const c = useProviderPage().toolkit.community
  const people = ['Amira Hassan', 'Leo Berg', 'Nora Okonkwo', 'Kenji Sato', 'Sofia Reyes']
  return (
    <Mock className="mt-auto">
      <div className="flex -space-x-2">
        {people.map(name => (
          <span
            key={name}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-neutral-950 ring-2 ring-neutral-50"
          >
            {initials(name)}
          </span>
        ))}
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-950 text-[0.6875rem] font-semibold text-white ring-2 ring-neutral-50">
          +81
        </span>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[0.625rem] font-medium uppercase tracking-wide text-neutral-500">{c.followers}</p>
          <p className="text-2xl font-bold tracking-tight text-neutral-950">312</p>
        </div>
        <div className="text-end">
          <p className="text-[0.625rem] font-medium uppercase tracking-wide text-neutral-500">{c.liveCopiers}</p>
          <p className="text-2xl font-bold tracking-tight text-green-600">86</p>
        </div>
      </div>
    </Mock>
  )
}

function AutomationFlow() {
  const c = useProviderPage().toolkit.automation
  return (
    <div className="mt-auto flex flex-col items-stretch gap-3 pt-8 sm:flex-row sm:items-center" dir="ltr" aria-hidden>
      <div className="flex-1 rounded-2xl bg-neutral-950 p-4 text-white">
        <p className=" text-[0.625rem] uppercase tracking-[0.14em] text-neutral-400">{c.yourTrade}</p>
        <p className="mt-2 text-sm font-semibold">
          <span className="rounded bg-green-400 px-1.5 py-0.5 text-xs text-neutral-950">BUY</span> XAUUSD 0.50
        </p>
      </div>
      <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-neutral-950 sm:rotate-0" aria-hidden />
      <div className="flex-1 rounded-2xl bg-white/70 p-4 ring-1 ring-neutral-950/10">
        <p className=" text-[0.625rem] uppercase tracking-[0.14em] text-neutral-950/60">{c.engine}</p>
        <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-950">
          <Zap className="h-4 w-4" aria-hidden />
          {'<50ms'}
        </p>
      </div>
      <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-neutral-950 sm:rotate-0" aria-hidden />
      <div className="flex-1 rounded-2xl bg-white/70 p-4 ring-1 ring-neutral-950/10">
        <p className=" text-[0.625rem] uppercase tracking-[0.14em] text-neutral-950/60">
          {c.followerAccounts}
        </p>
        <p className="mt-2 text-sm font-semibold text-neutral-950">86 ✓</p>
      </div>
    </div>
  )
}

export function ProviderToolkitSection() {
  const c = useProviderPage().toolkit

  return (
    <section id="provider-toolkit" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-16 sm:px-8 sm:py-24">
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
        <div>
          <Eyebrow>{c.eyebrow}</Eyebrow>
          <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1] dark:text-white">
            {c.title}
          </h2>
        </div>
        <p className="max-w-md text-sm leading-relaxed text-neutral-600 sm:text-base dark:text-neutral-300">
          {c.description}
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:mt-14 md:grid-cols-2 lg:grid-cols-6">
        <article className={clsx(CARD, 'lg:col-span-2')}>
          <CardHead icon={Tag} title={c.pricing.title} description={c.pricing.description} />
          <PricingMock />
        </article>
        <article className={clsx(CARD, 'lg:col-span-2')}>
          <CardHead icon={ShieldCheck} title={c.access.title} description={c.access.description} />
          <AccessMock />
        </article>
        <article className={clsx(CARD, 'md:col-span-2 lg:col-span-2')}>
          <CardHead icon={BarChart3} title={c.profile.title} description={c.profile.description} />
          <ProfileMock />
        </article>

        <article className={clsx(CARD, 'lg:col-span-2')}>
          <CardHead icon={Users} title={c.community.title} description={c.community.description} />
          <CommunityMock />
        </article>
        <article className={clsx(CARD, 'border-green-400 bg-green-400 md:col-span-1 lg:col-span-4')}>
          <CardHead
            featured
            icon={Zap}
            title={c.automation.title}
            description={c.automation.description}
          />
          <AutomationFlow />
        </article>
      </div>
    </section>
  )
}
