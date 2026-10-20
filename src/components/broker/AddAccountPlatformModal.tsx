import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import type { TradingPlatform } from '../../lib/tradingPlatform'

type AssetClass = 'forex' | 'crypto' | 'futures'

type PlatformTile = {
  id: string
  name: string
  logo: string
  asset: AssetClass
  /** Set when a connection flow exists. Tiles without one render as coming soon. */
  platform?: TradingPlatform
}

const PLATFORM_TILES: readonly PlatformTile[] = [
  { id: 'mt5', name: 'MT5', logo: '/MT5.png', asset: 'forex', platform: 'MT5' },
  { id: 'mt4', name: 'MT4', logo: '/MT4.png', asset: 'forex', platform: 'MT4' },
  { id: 'ctrader', name: 'cTrader', logo: '/cTrader.png', asset: 'forex', platform: 'cTrader' },
  { id: 'binance', name: 'Binance USD-M', logo: '/Binance.png', asset: 'crypto', platform: 'Binance' },
  { id: 'bybit', name: 'Bybit Linear', logo: '/Bybit.png', asset: 'crypto', platform: 'Bybit' },
  { id: 'kucoin', name: 'KuCoin Futures', logo: '/Kucoin.png', asset: 'crypto', platform: 'KuCoin' },
  { id: 'dxtrade', name: 'DX-Trade', logo: '/DX-trade.png', asset: 'forex', platform: 'DXtrade' },
  { id: 'tradovate', name: 'Tradovate', logo: '/Tradovate.png', asset: 'futures' },
  { id: 'tradelocker', name: 'TradeLocker', logo: '/Trade_locker.png', asset: 'forex', platform: 'TradeLocker' },
  { id: 'matchtrader', name: 'MatchTrader', logo: '/Match-Trader.png', asset: 'forex' },
]

type AddAccountPlatformModalProps = {
  open: boolean
  onClose: () => void
  onSelect: (platform: TradingPlatform) => void
}

/** First step of Add account: pick the platform, then the matching connect form opens. */
export function AddAccountPlatformModal({ open, onClose, onSelect }: AddAccountPlatformModalProps) {
  const t = useT()
  const copy = t.accountConfig.addAccount
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onClose)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  const assetLabel: Record<AssetClass, string> = {
    forex: copy.assetForex,
    crypto: copy.assetCrypto,
    futures: copy.assetFutures,
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55 animate-in" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-platform-title"
        className="relative flex max-h-[min(92dvh,48rem)] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl animate-modal-in dark:bg-neutral-900"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
          <div className="min-w-0">
            <h2
              id="add-account-platform-title"
              className="text-lg font-semibold text-neutral-900 dark:text-neutral-50"
            >
              {copy.title}
            </h2>
            <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-50">{copy.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.cancel}
            className="rounded-xl p-3 text-neutral-900 transition-colors hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="mx-6 h-px bg-neutral-100 dark:bg-neutral-800 sm:mx-8" />

        <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            {PLATFORM_TILES.map(tile => {
              const available = tile.platform != null
              return (
                <li key={tile.id}>
                  <button
                    type="button"
                    disabled={!available}
                    onClick={() => {
                      if (tile.platform) onSelect(tile.platform)
                    }}
                    aria-label={available ? tile.name : `${tile.name} — ${copy.comingSoonBadge}`}
                    className={clsx(
                      'group relative flex h-full w-full flex-col items-center gap-2 rounded-2xl border px-2 py-4 text-center transition-all',
                      available
                        ? 'border-neutral-200/65 bg-white hover:-translate-y-0.5 hover:border-green-400 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 dark:border-neutral-800/55 dark:bg-neutral-900'
                        : 'cursor-not-allowed border-neutral-100 bg-neutral-50/60 dark:border-neutral-800/40 dark:bg-neutral-900/50',
                    )}
                  >
                    {!available ? (
                      <span className="absolute right-2 top-2 rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50">
                        {copy.comingSoonBadge}
                      </span>
                    ) : null}
                    <span className="flex h-14 w-full items-center justify-center">
                      <img
                        src={tile.logo}
                        alt=""
                        draggable={false}
                        className={clsx(
                          'max-h-14 max-w-18 object-contain transition-transform',
                          available ? 'group-hover:scale-105' : 'opacity-50 grayscale',
                        )}
                      />
                    </span>
                    <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                      {tile.name}
                    </span>
                    <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50">
                      {assetLabel[tile.asset]}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

        </div>
      </div>
    </div>
  )
}
