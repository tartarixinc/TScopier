import { ChevronDown } from 'lucide-react'
import { marketingUrl } from '../../../lib/site'
import { Eyebrow, ProviderCta } from './shared'
import { useProviderPage } from './helpers'

export function ProviderFaqSection() {
  const c = useProviderPage().faq

  return (
    <section id="faq" className="mx-auto max-w-6xl scroll-mt-28 px-5 py-16 sm:px-8 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div>
          <Eyebrow>{c.eyebrow}</Eyebrow>
          <h2 className="mt-5 max-w-sm text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl lg:leading-[1.1] dark:text-white">
            {c.title}
          </h2>
        </div>
        <div className="marketing-faq-list">
          {c.items.map(item => (
            <details key={item.question} className="marketing-faq-item group">
              <summary className="marketing-faq-question">
                <span>{item.question}</span>
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-neutral-900 transition-transform duration-200 group-open:rotate-180 dark:text-neutral-50"
                  aria-hidden
                />
              </summary>
              <p className="marketing-faq-answer">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function ProviderFinalCta() {
  const c = useProviderPage().finalCta

  return (
    <section className="mx-auto max-w-[80rem] px-3 pb-12 pt-4 sm:px-5 sm:pb-16">
      <article className="relative isolate overflow-hidden rounded-[2rem] bg-green-400 px-7 py-14 text-center text-neutral-950 sm:px-12 sm:py-20">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.22] mix-blend-multiply"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
            backgroundSize: '140px 140px',
          }}
          aria-hidden
        />
        <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl lg:leading-[1.08]">
          {c.title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-neutral-950/80 sm:text-base">
          {c.description}
        </p>
        <div className="mt-8 flex flex-col items-center gap-4">
          <ProviderCta
            label={c.primaryCta}
            placement="final"
            className="!border-neutral-950 !bg-neutral-950 !text-white !shadow-none hover:!shadow-[0_12px_30px_-10px_rgba(0,0,0,0.6)]"
          />
          <a
            href={marketingUrl('/')}
            className="text-sm font-medium text-neutral-950 underline decoration-neutral-950/40 underline-offset-4 transition-colors hover:decoration-neutral-950"
          >
            {c.traderLink}
          </a>
        </div>
      </article>
    </section>
  )
}
