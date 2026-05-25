import { Cloud, Timer, Zap } from 'lucide-react'
import { GlassCard } from '../GlassCard'
import { useT } from '../../../context/LocaleContext'

const ICONS = [Zap, Cloud, Timer] as const

export function WhyChooseSection() {
  const l = useT().landing.whyChoose

  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">{l.subtitle}</p>
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {l.items.map((item, i) => {
          const Icon = ICONS[i] ?? Zap
          return (
            <GlassCard key={item.title} variant="feature">
              <div className="mb-4 inline-flex rounded-xl bg-teal-500/10 p-2.5 text-teal-600 dark:text-teal-400">
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {item.description}
              </p>
            </GlassCard>
          )
        })}
      </div>
    </section>
  )
}
