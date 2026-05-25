import { GlassCard } from '../GlassCard'
import { TrustpilotStars } from '../../auth/TrustpilotStars'
import { useT } from '../../../context/LocaleContext'

export function ReviewsSection() {
  const l = useT().landing.reviews

  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400">
          {l.trustpilotLabel}
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {l.items.map((review) => (
          <GlassCard key={review.author} className="flex flex-col p-6">
            <TrustpilotStars className="mb-4 justify-start" />
            <blockquote className="flex-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
              &ldquo;{review.quote}&rdquo;
            </blockquote>
            <p className="mt-4 text-sm font-medium text-neutral-900 dark:text-neutral-50">
              {review.author}
            </p>
          </GlassCard>
        ))}
      </div>
    </section>
  )
}
