import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'

const PLATFORMS = [
  { value: 'MT5', label: 'MetaTrader 5', logo: '/MT5.png' },
  { value: 'MT4', label: 'MetaTrader 4', logo: '/MT4.png' },
  { value: 'cTrader', label: 'cTrader', logo: '/cTrader.png' },
  { value: 'TradeLocker', label: 'Trade Locker', logo: '/Trade_locker.png' },
  { value: 'MatchTrader', label: 'Match-Trader', logo: '/Match-Trader.png' },
  { value: 'Tradovate', label: 'Tradovate', logo: '/Tradovate.png' },
  { value: 'DXTrade', label: 'DX Trade', logo: '/DX-trade.png' },
  { value: 'Binance', label: 'Binance', logo: '/Binance.png' },
] as const

const AVAILABLE_PLATFORMS = new Set<string>(['MT4', 'MT5'])

function isPlatformAvailable(value: string): boolean {
  return AVAILABLE_PLATFORMS.has(value)
}

interface AddAccountModalProps {
  open: boolean
  onClose: () => void
  onSelect: (platform: string) => void
}

function PlatformTile({
  label,
  logo,
  available,
  comingSoonLabel,
  onSelect,
}: {
  label: string
  logo: string
  available: boolean
  comingSoonLabel: string
  onSelect?: () => void
}) {
  const logoBlock = (
    <div
      className={clsx(
        'w-22 h-22 sm:w-24 sm:h-24 rounded-2xl bg-white dark:bg-neutral-900 shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center justify-center overflow-hidden',
        available && 'group-hover:shadow-md transition-shadow duration-150',
      )}
    >
      <img
        src={logo}
        alt={label}
        className={clsx(
          'w-[4.5rem] h-[4.5rem] sm:w-20 sm:h-20 object-contain',
          !available && 'opacity-50 grayscale',
        )}
      />
    </div>
  )

  const labelBlock = (
    <span
      className={clsx(
        'text-sm sm:text-base font-medium text-center leading-snug',
        available
          ? 'text-neutral-700 dark:text-neutral-300 group-hover:text-teal-700 dark:group-hover:text-teal-400 transition-colors duration-150'
          : 'text-neutral-500 dark:text-neutral-500',
      )}
    >
      {label}
    </span>
  )

  const badge = !available ? (
    <span className="inline-flex items-center rounded-full bg-neutral-200/80 dark:bg-neutral-700/80 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
      {comingSoonLabel}
    </span>
  ) : null

  const tileClass = clsx(
    'flex flex-col items-center gap-3 p-6 sm:p-7 rounded-2xl border',
    available
      ? clsx(
          'group border-neutral-150 bg-neutral-50 dark:bg-neutral-800/50',
          'hover:bg-white dark:hover:bg-neutral-900 hover:border-teal-400 hover:shadow-lg hover:shadow-teal-500/10',
          'transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 cursor-pointer',
        )
      : 'border-neutral-100 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-800/30 opacity-75 cursor-not-allowed',
  )

  if (available && onSelect) {
    return (
      <button type="button" onClick={onSelect} className={tileClass}>
        {logoBlock}
        {labelBlock}
      </button>
    )
  }

  return (
    <div className={tileClass} aria-disabled="true">
      {logoBlock}
      {labelBlock}
      {badge}
    </div>
  )
}

export function AddAccountModal({ open, onClose, onSelect }: AddAccountModalProps) {
  const t = useT()
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  const comingSoonLabel = t.accountConfig.addAccount.comingSoonBadge

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-8"
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm animate-in" />

      <div className="relative bg-white dark:bg-neutral-900 rounded-3xl shadow-2xl w-full max-w-5xl animate-modal-in overflow-hidden">
        <div className="px-10 sm:px-12 pt-10 sm:pt-12 pb-6 sm:pb-8">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h2 className="text-lg sm:text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {t.accountConfig.addAccount.title}
              </h2>
              <p className="text-base sm:text-md text-neutral-500 dark:text-neutral-400 mt-2">
                {t.accountConfig.addAccount.subtitle}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.common.cancel}
              className="shrink-0 p-3 rounded-xl text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="h-px bg-neutral-100 dark:bg-neutral-800 mx-10 sm:mx-12" />

        <div className="p-8 sm:p-12 grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-8">
          {PLATFORMS.map(p => {
            const available = isPlatformAvailable(p.value)
            return (
              <PlatformTile
                key={p.value}
                label={p.label}
                logo={p.logo}
                available={available}
                comingSoonLabel={comingSoonLabel}
                onSelect={available ? () => onSelect(p.value) : undefined}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
