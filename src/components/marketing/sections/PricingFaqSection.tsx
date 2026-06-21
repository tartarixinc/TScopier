import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'

export function PricingFaqSection({ variant = 'marketing' }: { variant?: 'marketing' | 'app' }) {
  const f = useT().landing.pricingFaq
  const isApp = variant === 'app'

  return (
    <section
      id="pricing-faq"
      className={clsx(
        'mx-auto max-w-6xl scroll-mt-28',
        isApp ? 'px-0 py-8 sm:py-10' : 'px-5 py-16 sm:px-8 sm:py-24',
      )}
    >
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          {f.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {f.title}
        </h2>
        <p className="mt-4 text-base text-neutral-600 dark:text-neutral-400">{f.subtitle}</p>
      </div>

      <div className="marketing-faq-list mx-auto mt-10 max-w-3xl sm:mt-12">
        {f.items.map((item) => (
          <details key={item.question} className="marketing-faq-item group">
            <summary className="marketing-faq-question">
              <span>{item.question}</span>
              <ChevronDown
                className="h-5 w-5 shrink-0 text-neutral-400 transition-transform duration-200 group-open:rotate-180 dark:text-neutral-500"
                aria-hidden
              />
            </summary>
            <p className="marketing-faq-answer">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
