import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, Copy, Radio, Star, Users, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { appUrl, marketingUrl } from '../../lib/site'

type ProductKey = 'signalCopier' | 'socialTrading' | 'accountMirroring'

type ProductEntry = {
  key: ProductKey
  icon: LucideIcon
  /** Flat icon tile colour (brand green, black icon). */
  tone: string
  href: string
}

const PRODUCTS: readonly ProductEntry[] = [
  { key: 'signalCopier', icon: Radio, tone: 'bg-green-400', href: '#features' },
  { key: 'socialTrading', icon: Users, tone: 'bg-green-400', href: appUrl('/social-trading') },
  { key: 'accountMirroring', icon: Copy, tone: 'bg-green-400', href: appUrl('/mirror-trading') },
]

const SIGNAL_SOURCES = [
  { name: 'Telegram', src: '/Telegram.svg' },
  { name: 'Discord', src: '/discord-logo.png' },
  { name: 'WhatsApp', src: '/whatsapp-icon.png' },
  { name: 'TradingView', src: '/tradingview-logo.png' },
] as const

const PLATFORMS = [
  { name: 'MetaTrader 4', src: '/MT4.png' },
  { name: 'MetaTrader 5', src: '/MT5.png' },
  { name: 'cTrader', src: '/cTrader.png' },
  { name: 'Binance', src: '/Binance.png' },
  { name: 'Bybit', src: '/Bybit.png' },
  { name: 'KuCoin', src: '/Kucoin.png' },
] as const

const PANEL_GLASS =
  'border border-white/80 bg-white/80 shadow-[0_24px_70px_-12px_rgba(15,23,42,0.25)] backdrop-blur-2xl dark:border-white/10 dark:bg-neutral-950/80 dark:shadow-[0_24px_70px_-12px_rgba(0,0,0,0.7)]'

function SourceDots() {
  return (
    <span className="mt-2 flex items-center">
      {SIGNAL_SOURCES.map(source => (
        <span
          key={source.name}
          className="-me-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-neutral-50 ring-2 ring-white dark:ring-neutral-900"
          title={source.name}
        >
          <img src={source.src} alt={source.name} className="h-3.5 w-3.5 object-contain" draggable={false} loading="lazy" />
        </span>
      ))}
    </span>
  )
}

/** Desktop "Product" trigger with a hover / click mega menu. */
export function MarketingProductMenu({ triggerClassName }: { triggerClassName: string }) {
  const nav = useT().landing.nav
  const copy = nav.productMenu
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<ProductKey>('signalCopier')
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const panelId = useId()

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), [])
  const openNow = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])
  const toggle = () => {
    if (!open) setActive('signalCopier')
    setOpen(value => !value)
  }
  const closeSoon = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }, [cancelClose])

  useEffect(() => cancelClose, [cancelClose])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const close = () => setOpen(false)
  const rows: Record<ProductKey, { title: string; description: string }> = {
    signalCopier: copy.signalCopier,
    socialTrading: copy.socialTrading,
    accountMirroring: copy.accountMirroring,
  }

  return (
    <div
      ref={rootRef}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeSoon()
      }}
    >
      <button
        type="button"
        className={clsx(triggerClassName, 'inline-flex items-center gap-1', open && 'bg-neutral-900/[0.06] text-neutral-950 dark:bg-white/10 dark:text-white')}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        onClick={toggle}
      >
        {nav.product}
        <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>

      {/* pt-3 bridges the gap to the nav so the pointer can travel into the panel. */}
      <div
        id={panelId}
        className={clsx(
          'absolute left-1/2 top-full z-50 w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 pt-3 transition-all duration-200 ease-out',
          open ? 'visible translate-y-0 opacity-100' : 'pointer-events-none invisible -translate-y-2 opacity-0',
        )}
      >
        <div className={clsx('rounded-[1.75rem] p-3', PANEL_GLASS)}>
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-1">
            <p className="px-3 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {copy.heading}
            </p>
            {PRODUCTS.map(product => {
              const Icon = product.icon
              const row = rows[product.key]
              return (
                <a
                  key={product.key}
                  href={product.href}
                  onClick={close}
                  onMouseEnter={() => setActive(product.key)}
                  onFocus={() => setActive(product.key)}
                  className={clsx(
                    'group flex items-start gap-4 rounded-2xl p-3 transition-colors focus-visible:outline-none',
                    active === product.key
                      ? 'bg-neutral-900/[0.05] dark:bg-white/[0.08]'
                      : 'hover:bg-neutral-900/[0.03] dark:hover:bg-white/[0.04]',
                  )}
                >
                  <span
                    className={clsx(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-neutral-950 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-105',
                      product.tone,
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-950 dark:text-white">
                      {row.title}
                      <ArrowRight className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 rtl:rotate-180 rtl:translate-x-1 rtl:group-hover:translate-x-0" aria-hidden />
                    </span>
                    <span className="mt-0.5 block text-[0.8rem] leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {row.description}
                    </span>
                    {product.key === 'signalCopier' ? <SourceDots /> : null}
                  </span>
                </a>
              )
            })}
          </div>

          <DetailPanel active={active} onNavigate={close} />
        </div>

        <div className="mt-3 flex items-center justify-between gap-4 border-t border-neutral-200/70 px-3 pb-1 pt-3 text-xs font-medium dark:border-white/10">
          <a href="#features" onClick={close} className="inline-flex items-center gap-1.5 text-neutral-700 transition-colors hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white">
            {copy.exploreFeatures}
            <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
          </a>
          <a href={marketingUrl('/pricing')} onClick={close} className="text-neutral-700 transition-colors hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white">
            {copy.viewPricing}
          </a>
        </div>
        </div>
      </div>
    </div>
  )
}

/** Illustrative rows, mirroring the in-app Social Trading list. */
const SAMPLE_TRADERS = [
  { name: 'Amira Hassan', rating: 4.8, roi: '34.2%', following: true },
  { name: 'Nora Okonkwo', rating: 4.6, roi: '27.8%', following: false },
  { name: 'Kenji Sato', rating: 4.0, roi: '9.1%', following: false },
] as const

const ACCENT_GLOW: Record<ProductKey, { a: string; b: string }> = {
  signalCopier: { a: 'bg-green-400/35', b: 'bg-cyan-400/20' },
  socialTrading: { a: 'bg-sky-400/35', b: 'bg-green-400/20' },
  accountMirroring: { a: 'bg-teal-400/35', b: 'bg-emerald-400/20' },
}

function LogoTile({ name, src, className }: { name: string; src: string; className?: string }) {
  return (
    <li
      className={clsx(
        'flex items-center justify-center rounded-xl bg-white/95 ring-1 ring-white/20 transition-transform duration-200 hover:scale-105',
        className,
      )}
      title={name}
    >
      <img src={src} alt={name} className="h-6 w-6 object-contain" draggable={false} loading="lazy" />
    </li>
  )
}

/** Right-hand panel; swaps its visual as the product rows are hovered or focused. */
function DetailPanel({ active, onNavigate }: { active: ProductKey; onNavigate: () => void }) {
  const nav = useT().landing.nav
  const copy = nav.productMenu
  const glow = ACCENT_GLOW[active]
  const text =
    active === 'signalCopier'
      ? { title: copy.featuredTitle, body: copy.featuredBody }
      : active === 'socialTrading'
        ? copy.socialPanel
        : copy.mirrorPanel

  return (
    <div className="relative flex min-h-[21.5rem] flex-col justify-between overflow-hidden rounded-2xl bg-neutral-950 p-5 text-white">
      <div className={clsx('pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full blur-3xl transition-colors duration-500', glow.a)} aria-hidden />
      <div className={clsx('pointer-events-none absolute -bottom-12 -left-8 h-40 w-40 rounded-full blur-3xl transition-colors duration-500', glow.b)} aria-hidden />

      {/* key remounts the content so it fades in on every switch. */}
      <div key={active} className="mega-detail-in relative">
        <p className="text-base font-semibold tracking-tight">{text.title}</p>
        <p className="mt-1 text-[0.8rem] leading-relaxed text-neutral-300">{text.body}</p>

        {active === 'signalCopier' ? (
          <div className="mt-4">
            <ul className="grid grid-cols-4 gap-2" role="list">
              {SIGNAL_SOURCES.map(source => (
                <LogoTile key={source.name} name={source.name} src={source.src} className="aspect-square" />
              ))}
            </ul>
            <div className="my-2 flex items-center gap-2 text-[0.7rem] font-semibold text-green-400" aria-hidden>
              <span className="h-px flex-1 bg-white/15" />
              &lt;50ms
              <span className="h-px flex-1 bg-white/15" />
            </div>
            <ul className="grid grid-cols-6 gap-2" role="list">
              {PLATFORMS.map(platform => (
                <LogoTile key={platform.name} name={platform.name} src={platform.src} className="aspect-square" />
              ))}
            </ul>
          </div>
        ) : null}

        {active === 'socialTrading' ? (
          <ul className="mt-4 divide-y divide-neutral-200 overflow-hidden rounded-xl bg-white text-neutral-900 shadow-lg" role="list">
            {SAMPLE_TRADERS.map(trader => (
              <li key={trader.name} className="flex items-center gap-2.5 px-3 py-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                  {trader.name[0]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold leading-tight">{trader.name}</span>
                  <span className="mt-0.5 flex items-center gap-1">
                    <span className="flex" aria-hidden>
                      {[1, 2, 3, 4, 5].map(n => (
                        <Star
                          key={n}
                          className={clsx('h-2.5 w-2.5', n <= Math.round(trader.rating) ? 'fill-green-400 text-green-400' : 'fill-transparent text-neutral-300')}
                        />
                      ))}
                    </span>
                    <span className="text-[0.65rem] text-neutral-600">{trader.rating.toFixed(1)}</span>
                  </span>
                </span>
                <span className="text-end">
                  <span className="block text-xs font-semibold">{trader.roi}</span>
                  <span className="block text-[0.6rem] uppercase tracking-wide text-neutral-500">{copy.labels.roi}</span>
                </span>
                <span
                  className={clsx(
                    'shrink-0 rounded-md px-2 py-1 text-[0.65rem] font-semibold',
                    trader.following
                      ? 'border border-neutral-200 bg-white text-neutral-900'
                      : 'bg-green-400 text-neutral-950',
                  )}
                >
                  {trader.following ? copy.labels.following : copy.labels.copyTrader}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {active === 'accountMirroring' ? (
          <div className="mt-4 flex items-center gap-3">
            <div className="flex flex-col items-center gap-1.5">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/95 ring-2 ring-teal-400">
                <img src="/MT5.png" alt="" className="h-7 w-7 object-contain" draggable={false} />
              </div>
              <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-teal-300">{copy.labels.master}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2.5" aria-hidden>
              {[0, 1, 2].map(i => (
                <span key={i} className="h-px w-full bg-gradient-to-r from-teal-400/80 to-teal-400/10" />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {[
                { name: 'MetaTrader 4', src: '/MT4.png' },
                { name: 'cTrader', src: '/cTrader.png' },
                { name: 'Binance', src: '/Binance.png' },
              ].map(slave => (
                <div key={slave.name} className="flex items-center gap-2 rounded-xl bg-white/[0.07] px-2.5 py-1.5 ring-1 ring-white/10" title={slave.name}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/95">
                    <img src={slave.src} alt="" className="h-4 w-4 object-contain" draggable={false} />
                  </span>
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-neutral-300">{copy.labels.slave}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <a
        href={appUrl('/signup')}
        onClick={onNavigate}
        className="relative mt-5 inline-flex w-fit items-center gap-1.5 rounded-full bg-green-400 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_6px_18px_-8px_rgba(74,222,128,0.8)] transition-all hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_20px_rgba(74,222,128,0.55)]"
      >
        {nav.getStarted}
        <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
      </a>
    </div>
  )
}

/** Mobile drawer version: an accordion with the same three products. */
export function MarketingProductMenuMobile({
  linkClassName,
  onNavigate,
}: {
  linkClassName: string
  onNavigate: () => void
}) {
  const nav = useT().landing.nav
  const copy = nav.productMenu
  const [open, setOpen] = useState(false)
  const rows: Record<ProductKey, { title: string; description: string }> = {
    signalCopier: copy.signalCopier,
    socialTrading: copy.socialTrading,
    accountMirroring: copy.accountMirroring,
  }

  return (
    <div>
      <button
        type="button"
        className={clsx(linkClassName, 'flex w-full items-center justify-between')}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {nav.product}
        <ChevronDown className={clsx('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div className="mb-1 mt-1 flex flex-col gap-1 ps-2">
          {PRODUCTS.map(product => {
            const Icon = product.icon
            const row = rows[product.key]
            return (
              <a
                key={product.key}
                href={product.href}
                onClick={onNavigate}
                className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-neutral-900/[0.06] dark:hover:bg-white/10"
              >
                <span className={clsx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-950', product.tone)}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-neutral-900 dark:text-neutral-50">{row.title}</span>
                  <span className="block text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{row.description}</span>
                </span>
              </a>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
