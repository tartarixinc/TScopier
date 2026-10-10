import { StepVisual } from '../steps/StepVisual'
import { useT } from '../../../context/LocaleContext'

export function StepsSection() {
  const l = useT().landing.steps

  return (
    <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-28 px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          {l.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">{l.subtitle}</p>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-3 lg:gap-6">
        {l.items.map((step, index) => (
          <article key={step.title} className="flex flex-col">
            <div className="mb-5 flex items-start gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-600 text-sm font-bold text-white">
                {index + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                  {step.description}
                </p>
              </div>
            </div>
            <div className="marketing-step-visual-panel min-h-[240px] overflow-hidden rounded-2xl border border-neutral-200/55 bg-neutral-50/50 dark:border-neutral-800/55 dark:bg-neutral-900/40">
              <StepVisual id={step.visual} />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
