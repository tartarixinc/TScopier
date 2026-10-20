import { useId, useState } from 'react'
import { Grain, Eyebrow, ProviderCta } from './shared'
import { useProviderPage } from './helpers'

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function Slider({
  id,
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  id: string
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-neutral-300">
          {label}
        </label>
        <output htmlFor={id} className="text-2xl font-bold tracking-tight text-white">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="provider-range mt-4 w-full"
        style={{
          background: `linear-gradient(to right, #4ade80 ${pct}%, rgba(255,255,255,0.14) ${pct}%)`,
        }}
      />
    </div>
  )
}

/** Interactive "what could I earn" estimator: copiers x monthly price. */
export function ProviderEarningsCalculator() {
  const c = useProviderPage().calculator
  const uid = useId()
  const [copiers, setCopiers] = useState(40)
  const [price, setPrice] = useState(50)

  const monthly = copiers * price

  return (
    <section className="mx-auto max-w-[80rem] px-3 py-8 sm:px-5 sm:py-12">
      <article
        className="relative isolate overflow-hidden rounded-[2rem] ring-1 ring-black/5 dark:ring-white/10"
        style={{ backgroundImage: 'linear-gradient(160deg, #161d26 0%, #0c1015 75%)' }}
      >
        <Grain className="-z-10 opacity-[0.1]" />
        <div className="grid gap-10 p-7 sm:p-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:p-14">
          <div className="flex flex-col justify-center">
            <Eyebrow onDark>{c.eyebrow}</Eyebrow>
            <h2 className="mt-5 max-w-lg text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
              {c.title}
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-neutral-300 sm:text-base">{c.description}</p>
            <div className="mt-8">
              <ProviderCta label={c.cta} placement="calculator" />
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-xl sm:p-8">
            <div className="space-y-8">
              <Slider
                id={`${uid}-copiers`}
                label={c.copiers}
                value={copiers}
                display={String(copiers)}
                min={5}
                max={500}
                step={5}
                onChange={setCopiers}
              />
              <Slider
                id={`${uid}-price`}
                label={c.price}
                value={price}
                display={money.format(price)}
                min={10}
                max={200}
                step={5}
                onChange={setPrice}
              />
            </div>

            <div className="mt-8 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-green-400 p-5 text-neutral-950">
                <p className=" text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-950/70">
                  {c.perMonth}
                </p>
                <p className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{money.format(monthly)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-5">
                <p className=" text-[0.625rem] font-medium uppercase tracking-[0.14em] text-neutral-400">
                  {c.perYear}
                </p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
                  {money.format(monthly * 12)}
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3.5">
              <span className="text-sm text-neutral-300">{c.keep}</span>
              <span className="text-lg font-bold text-green-400">{c.keepValue}</span>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-neutral-500">{c.disclaimer}</p>
          </div>
        </div>
      </article>
    </section>
  )
}
