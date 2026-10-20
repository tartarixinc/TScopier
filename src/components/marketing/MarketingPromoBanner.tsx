import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useT } from '../../context/LocaleContext'
import { useMarketingPromo } from '../../hooks/useMarketingPromo'
import { countdownParts, isExternalPromoHref, promoMediaKind, type MarketingPromo } from '../../lib/marketingPromo'
import { useReportPromoHeight } from '../../hooks/useMarketingPromoOffset'

const MOBILE_QUERY = '(max-width: 639px)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function useMediaQueryMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

const pad = (n: number) => String(n).padStart(2, '0')

function Countdown({ endsAt, onDone }: { endsAt: number; onDone: () => void }) {
  const p = useT().landing.promo
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const parts = countdownParts(endsAt, now)
  useEffect(() => {
    if (parts.done) onDone()
  }, [parts.done, onDone])
  if (parts.done) return null

  const cells: Array<[number, string]> = [
    ...(parts.days > 0 ? [[parts.days, p.days] as [number, string]] : []),
    [parts.hours, p.hours],
    [parts.minutes, p.minutes],
    [parts.seconds, p.seconds],
  ]

  return (
    <div role="timer" aria-label={p.endsIn} className="flex items-center gap-1.5">
      {cells.map(([value, label], index) => (
        <div key={label} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden className="text-sm font-semibold text-white/60">:</span> : null}
          <div className="flex min-w-[2.5rem] flex-col items-center leading-none">
            <span className="text-base font-bold tabular-nums sm:text-lg">{pad(value)}</span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-white/70">{label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function CouponChip({ code }: { code: string }) {
  const p = useT().landing.promo
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      const area = document.createElement('textarea')
      area.value = code
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        document.execCommand('copy')
      } finally {
        document.body.removeChild(area)
      }
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`${p.copyCoupon}: ${code}`}
      title={p.copyCoupon}
      className="inline-flex items-center gap-2 rounded-lg border border-dashed border-white/60 bg-white/10 px-3 py-1.5 text-sm font-bold tracking-wider text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <span className="sr-only">{p.couponLabel}</span>
      <span>{code}</span>
      {copied ? <Check className="h-4 w-4 text-green-300" aria-hidden /> : <Copy className="h-4 w-4 text-white/80" aria-hidden />}
      <span role="status" className="sr-only">{copied ? p.copied : ''}</span>
    </button>
  )
}

const ctaClass =
  'inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-neutral-950 shadow-sm transition-colors hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'

function PromoCta({ promo }: { promo: MarketingPromo }) {
  if (!promo.ctaHref || !promo.ctaLabel) return null
  if (isExternalPromoHref(promo.ctaHref)) {
    return (
      <a href={promo.ctaHref} target="_blank" rel="noopener noreferrer" className={ctaClass}>
        {promo.ctaLabel}
      </a>
    )
  }
  return (
    <Link to={promo.ctaHref} className={ctaClass}>
      {promo.ctaLabel}
    </Link>
  )
}

function PromoMedia({ promo }: { promo: MarketingPromo }) {
  const mobile = useMediaQueryMatch(MOBILE_QUERY)
  const reduced = useMediaQueryMatch(REDUCED_MOTION_QUERY)
  const [failed, setFailed] = useState<string | null>(null)

  const url = mobile && promo.mediaUrlMobile ? promo.mediaUrlMobile : promo.mediaUrl
  if (!url || failed === url) return null

  const cover = 'absolute inset-0 h-full w-full object-cover'
  if (promoMediaKind(url) === 'video') {
    return (
      <video
        key={url}
        className={cover}
        src={url}
        autoPlay={!reduced}
        muted
        loop
        playsInline
        preload={reduced ? 'metadata' : 'auto'}
        aria-hidden
        tabIndex={-1}
        onError={() => setFailed(url)}
      />
    )
  }
  return <img key={url} className={cover} src={url} alt="" aria-hidden onError={() => setFailed(url)} />
}

/**
 * Promo banner above the marketing nav (table `marketing_promo_banner`): background media, headline, countdown,
 * coupon code and a button. It scrolls away with the page; the floating nav stays fixed.
 */
export function MarketingPromoBanner() {
  const t = useT()
  const p = t.landing.promo
  const { promo, dismiss } = useMarketingPromo()
  const reportHeight = useReportPromoHeight()
  const ref = useRef<HTMLDivElement>(null)
  const [endedFor, setEndedFor] = useState<string | null>(null)

  const ended = promo != null && endedFor === promo.id
  const visible = promo != null && !ended

  useEffect(() => {
    const el = ref.current
    if (!visible || !el) {
      reportHeight(0)
      return
    }
    const report = () => reportHeight(el.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => {
      observer.disconnect()
      reportHeight(0)
    }
  }, [visible, reportHeight])

  if (!promo || ended) return null

  return (
    <div
      ref={ref}
      role="region"
      aria-label={p.regionLabel}
      className="relative isolate z-40 w-full overflow-hidden bg-gradient-to-r from-indigo-950 via-violet-900 to-indigo-950 text-white"
    >
      <PromoMedia promo={promo} />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/30 to-black/55" />

      <div className="relative mx-auto flex min-h-[76px] max-w-7xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-10 py-3 sm:px-14 lg:py-0">
        {promo.headline ? (
          <p className="text-center text-sm font-semibold leading-snug sm:text-base">{promo.headline}</p>
        ) : null}
        {promo.endsAt != null ? <Countdown endsAt={promo.endsAt} onDone={() => setEndedFor(promo.id)} /> : null}
        {promo.couponCode ? <CouponChip code={promo.couponCode} /> : null}
        <PromoCta promo={promo} />
      </div>

      {promo.dismissible ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label={p.dismiss}
          className="absolute end-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}
