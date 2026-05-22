import { FeatureShowcasePanel } from '../features/FeatureShowcasePanel'
import { FeatureVisual } from '../features/FeatureVisual'
import { useT } from '../../../context/LocaleContext'

export function FeaturesSection() {
  const l = useT().landing.features

  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-28 px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          {l.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">{l.subtitle}</p>
      </div>

      <div className="mt-12 space-y-8">
        {l.showcases.map((showcase, index) => (
          <FeatureShowcasePanel
            key={showcase.visual}
            eyebrow={showcase.eyebrow}
            title={showcase.title}
            description={showcase.description}
            reverse={index % 2 === 1}
            visual={<FeatureVisual id={showcase.visual} />}
          />
        ))}
      </div>
    </section>
  )
}
