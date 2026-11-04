import { BadgeCheck, Plug, SlidersHorizontal, Wallet, type LucideIcon } from 'lucide-react'
import { Eyebrow } from './shared'
import { useProviderPage } from './helpers'

const STEP_ICONS: readonly LucideIcon[] = [Plug, BadgeCheck, SlidersHorizontal, Wallet]

export function ProviderStepsSection() {
  const c = useProviderPage().steps

  return (
    <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-16 sm:px-8 sm:py-24">
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
        <div>
          <Eyebrow>{c.eyebrow}</Eyebrow>
          <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1] dark:text-white">
            {c.title}
          </h2>
        </div>
        <p className="max-w-md text-sm leading-relaxed text-neutral-600 sm:text-base dark:text-neutral-300">
          {c.description}
        </p>
      </div>

      <ol className="relative mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-4" role="list">
        {c.items.map((item, index) => {
          const Icon = STEP_ICONS[index]
          return (
            <li
              key={item.title}
              className="relative flex min-h-60 flex-col overflow-hidden rounded-[1.75rem] border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_32px_-16px_rgba(15,23,42,0.18)]"
            >
              <span
                className="pointer-events-none absolute -inset-e-2 -top-5 select-none  text-[6.5rem] font-bold leading-none text-neutral-100"
                aria-hidden
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-green-400 text-neutral-950">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="relative mt-auto pt-10 text-lg font-bold leading-tight tracking-tight text-neutral-950">
                {item.title}
              </h3>
              <p className="relative mt-2 text-sm leading-relaxed text-neutral-600">{item.description}</p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
