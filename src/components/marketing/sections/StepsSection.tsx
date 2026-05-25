import { GlassCard } from '../GlassCard'
import { useT } from '../../../context/LocaleContext'

export function StepsSection() {
  const l = useT().landing.steps

  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">{l.subtitle}</p>
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {l.items.map((step, i) => (
          <GlassCard key={step.title} className="relative p-6">
            <span className="mb-4 inline-flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-sm font-bold text-white">
              {i + 1}
            </span>
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {step.description}
            </p>
          </GlassCard>
        ))}
      </div>
    </section>
  )
}
