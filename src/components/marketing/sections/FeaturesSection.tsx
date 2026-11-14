import { FeatureShowcasePanel } from '../features/FeatureShowcasePanel'
import { FeatureVisual } from '../features/FeatureVisual'
import { useT } from '../../../context/LocaleContext'
import { ScrollReveal } from '../ScrollReveal'

export function FeaturesSection() {
  const l = useT().landing.features

  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-28 px-5 py-16 sm:px-8 sm:py-24">
      <ScrollReveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-green-400 dark:text-green-400">
          {l.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-900 dark:text-neutral-50">{l.subtitle}</p>
      </ScrollReveal>

      <div className="mt-12 space-y-8">
        {l.showcases.map((showcase, index) => (
          <ScrollReveal key={showcase.visual} delay={0.04 * index} y={36}>
            <FeatureShowcasePanel
              eyebrow={showcase.eyebrow}
              title={showcase.title}
              description={showcase.description}
              reverse={index % 2 === 1}
              visual={<FeatureVisual id={showcase.visual} />}
            />
          </ScrollReveal>
        ))}
      </div>
    </section>
  )
}
