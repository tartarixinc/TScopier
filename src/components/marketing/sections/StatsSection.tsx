import { MarketingStatsBar } from '../MarketingStatsBar'
import { useT } from '../../../context/LocaleContext'

/** Social-proof caption and headline stats, shown directly under the hero. */
export function StatsSection() {
  const l = useT().landing.whyChoose

  return (
    <section className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 sm:pt-20">
      <p className="mb-6 text-center text-sm text-neutral-900 dark:text-neutral-50 sm:mb-8 sm:text-base">
        {l.statsCaption}
      </p>
      <MarketingStatsBar stats={l.stats} />
    </section>
  )
}
