import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'

const PLATFORMS = [
  { value: 'MT5', label: 'MetaTrader 5', sublabel: 'MT5', logo: '/MT5.png' },
  { value: 'MT4', label: 'MetaTrader 4', sublabel: 'MT4', logo: '/MT4.png' },
  { value: 'cTrader', label: 'cTrader', sublabel: 'cTrader', logo: '/cTrader.png' },
  { value: 'TradeLocker', label: 'Trade Locker', sublabel: 'TradeLocker', logo: '/Trade_locker.png' },
  { value: 'MatchTrader', label: 'Match-Trader', sublabel: 'Match-Trader', logo: '/Match-Trader.png' },
  { value: 'Tradovate', label: 'Tradovate', sublabel: 'Tradovate', logo: '/Tradovate.png' },
  { value: 'DXTrade', label: 'DX Trade', sublabel: 'DX Trade', logo: '/DX-trade.png' },
  { value: 'Binance', label: 'Binance', sublabel: 'Binance', logo: '/Binance.png' },
]

interface AddAccountModalProps {
  open: boolean
  onClose: () => void
  onSelect: (platform: string) => void
}

export function AddAccountModal({ open, onClose, onSelect }: AddAccountModalProps) {
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

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm animate-in" />

      {/* Dialog */}
      <div className="relative bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg animate-modal-in overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Add a trading account</h2>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">Choose your preferred trading platform to get started</p>
            </div>
            <button
              onClick={onClose}
              className="ml-4 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-neutral-100 dark:bg-neutral-800 mx-6" />

        {/* Platform grid */}
        <div className="p-4 sm:p-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {PLATFORMS.map(p => (
            <button
              key={p.value}
              onClick={() => onSelect(p.value)}
              className={clsx(
                'group flex flex-col items-center gap-2.5 p-3 rounded-xl border border-neutral-150 bg-neutral-50 dark:bg-neutral-800/50',
                'hover:bg-white dark:bg-neutral-900 hover:border-teal-400 hover:shadow-md hover:shadow-teal-500/10',
                'transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1'
              )}
            >
              <div className="w-12 h-12 rounded-xl bg-white dark:bg-neutral-900 shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center justify-center overflow-hidden group-hover:shadow-md transition-shadow duration-150">
                <img
                  src={p.logo}
                  alt={p.label}
                  className="w-9 h-9 object-contain"
                />
              </div>
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 text-center leading-tight group-hover:text-teal-700 transition-colors duration-150">
                {p.label}
              </span>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-6 pb-5">
          <p className="text-xs text-neutral-400 text-center">
            More platforms coming soon
          </p>
        </div>
      </div>
    </div>
  )
}
