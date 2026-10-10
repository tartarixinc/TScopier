import { useEffect, useState } from 'react'
import type { LandingStatItem } from '../../i18n/locales/landing/types'
import {
  formatMarketingStatValue,
  parseMarketingStatValue,
  useCountUp,
  useInViewOnce,
} from './useMarketingStatCountUp'

interface MarketingStatsBarProps {
  stats: LandingStatItem[]
}

function AnimatedStatValue({
  value,
  active,
  delayMs = 0,
}: {
  value: string
  active: boolean
  delayMs?: number
}) {
  const parsed = parseMarketingStatValue(value)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (!active) return
    if (delayMs <= 0) {
      setStarted(true)
      return
    }
    const timer = window.setTimeout(() => setStarted(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])

  const count = useCountUp(parsed?.target ?? 0, started && parsed != null)

  if (!parsed) return <>{value}</>

  return <>{formatMarketingStatValue(count, parsed)}</>
}

function StatItem({
  stat,
  active,
  index,
}: {
  stat: LandingStatItem
  active: boolean
  index: number
}) {
  return (
    <div className="text-center">
      <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400 sm:text-base">
        {stat.label}
      </dt>
      <dd className="mt-2 text-2xl tracking-tight text-teal-700 dark:text-teal-400 sm:mt-3 sm:text-4xl lg:text-[2.75rem] lg:leading-none">
        <AnimatedStatValue value={stat.value} active={active} delayMs={index * 120} />
      </dd>
    </div>
  )
}

export function MarketingStatsBar({ stats }: MarketingStatsBarProps) {
  const { ref, inView } = useInViewOnce(0.2)

  return (
    <div ref={ref} className="mx-auto mb-12 max-w-6xl sm:mb-14">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-8 rounded-2xl border border-neutral-200/60 bg-white/70 px-6 py-8 shadow-sm backdrop-blur-sm dark:border-neutral-800/55 dark:bg-neutral-900/70 sm:grid-cols-4 sm:gap-8 sm:px-10 sm:py-10">
        {stats.map((stat, index) => (
          <StatItem key={stat.label} stat={stat} active={inView} index={index} />
        ))}
      </dl>
    </div>
  )
}
