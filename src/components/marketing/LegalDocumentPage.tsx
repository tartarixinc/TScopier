import { useEffect } from 'react'
import { MarketingLayout } from './MarketingLayout'
import { LEGAL_COMPANY } from '../../lib/legalCompany'
import type { LegalDocumentPageTranslations } from '../../i18n/legal/types'

export function LegalDocumentPage({ page }: { page: LegalDocumentPageTranslations }) {
  useEffect(() => {
    document.title = `${page.title} · TScopier`
  }, [page.title])

  const c = page.contact

  return (
    <MarketingLayout>
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16 lg:py-20">
        <header className="mb-10">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {page.lastUpdated}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
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

        <section className="mt-10 rounded-lg border border-neutral-200 bg-neutral-50/80 p-5 dark:border-neutral-800 dark:bg-neutral-900/50">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{c.title}</h2>
          <dl className="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.company}</dt>
              <dd>{LEGAL_COMPANY.legalName}, {LEGAL_COMPANY.entityDescription}</dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.ein}</dt>
              <dd>{LEGAL_COMPANY.ein}</dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.address}</dt>
              <dd>
                {LEGAL_COMPANY.addressLines.map(line => (
                  <span key={line} className="block">{line}</span>
                ))}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.phone}</dt>
              <dd>
                <a href={`tel:${LEGAL_COMPANY.phone.replace(/\D/g, '')}`} className="text-teal-600 hover:underline dark:text-teal-400">
                  {LEGAL_COMPANY.phone}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.emailSupport}</dt>
              <dd>
                <a href={`mailto:${LEGAL_COMPANY.emails.support}`} className="text-teal-600 hover:underline dark:text-teal-400">
                  {LEGAL_COMPANY.emails.support}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.emailLegal}</dt>
              <dd>
                <a href={`mailto:${LEGAL_COMPANY.emails.legal}`} className="text-teal-600 hover:underline dark:text-teal-400">
                  {LEGAL_COMPANY.emails.legal}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-800 dark:text-neutral-200">{c.emailDisputes}</dt>
              <dd>
                <a href={`mailto:${LEGAL_COMPANY.emails.disputes}`} className="text-teal-600 hover:underline dark:text-teal-400">
                  {LEGAL_COMPANY.emails.disputes}
                </a>
              </dd>
            </div>
          </dl>
        </section>

        {page.closing ? (
          <p className="mt-8 border-t border-neutral-200 pt-8 text-sm leading-relaxed text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
            {page.closing}
          </p>
        ) : null}
      </article>
    </MarketingLayout>
  )
}
