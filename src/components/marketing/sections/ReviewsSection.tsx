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
      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {l.items.map((review, index) => (
          <GlassCard key={`${review.author}-${index}`} className="flex flex-col p-6">
            <TrustpilotStars className="mb-4 justify-start" />
            {review.headline ? (
              <p className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                {review.headline}
              </p>
            ) : null}
            <blockquote className="flex-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
              &ldquo;{review.quote}&rdquo;
            </blockquote>
            <div className="mt-4">
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
                {review.author}
              </p>
              {review.role ? (
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {review.role}
                </p>
              ) : null}
            </div>
          </GlassCard>
        ))}
      </div>
    </section>
  )
}
