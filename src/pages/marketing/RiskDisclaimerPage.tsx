import { useEffect } from 'react'
import { MarketingLayout } from '../../components/marketing/MarketingLayout'
import { useT } from '../../context/LocaleContext'

export function RiskDisclaimerPage() {
  const page = useT().riskDisclaimerPage

  useEffect(() => {
    document.title = `${page.title} · TScopier`
  }, [page.title])

  return (
    <MarketingLayout>
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16 lg:py-20">
        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
            {page.title}
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-base">
            {page.intro}
          </p>
        </header>

        <div className="space-y-8">
          {page.sections.map(section => (
            <section key={section.title}>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {section.title}
              </h2>
              <div className="mt-3 space-y-3">
                {section.paragraphs.map((paragraph, idx) => (
                  <p
                    key={idx}
                    className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-10 border-t border-neutral-200 pt-8 text-sm leading-relaxed text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
          {page.closing}
        </p>
      </article>
    </MarketingLayout>
  )
}
