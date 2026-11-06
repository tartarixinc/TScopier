import { SignalSourceLogo } from '../../dashboard/SignalSourceLogo'
import { useT } from '../../../context/LocaleContext'
import {
  AppPreviewWindow,
  PREVIEW_CARD,
  PreviewBadge,
  PreviewPageHeader,
  PreviewToggle,
} from './AppPreviewWindow'
import clsx from 'clsx'

const CHANNELS = [
  { name: 'Gold Signals Pro', username: 'goldsignalspro', brokers: [{ label: 'MT5 · #88291', icon: '/MT5.png' }, { label: 'MT4 · #44102', icon: '/MT4.png' }], active: true },
  { name: 'FX Scalper VIP', username: 'fxscalpervip', brokers: [{ label: 'MT4 · #44102', icon: '/MT4.png' }], active: true },
  { name: 'Crypto Whales', username: 'cryptowhales', brokers: [{ label: 'USD-M', icon: '/Binance.png' }], active: true },
  { name: 'London Breakout', username: 'londonbreakout', brokers: [{ label: 'cTrader · #9035', icon: '/cTrader.png' }], active: false },
] as const

/** The Signal Source page: Telegram channels, linked accounts and an active toggle per channel. */
export function SignalSourcePreview() {
  const t = useT()
  const c = t.channelsPage
  const tabs = [c.tabTelegram, c.tabDiscord, c.tabWhatsApp, c.tabTradingView]

  return (
    <AppPreviewWindow activeRoute="/channels">
      <PreviewPageHeader title={c.title} action={c.addChannel} />
      <div className="mb-4 flex items-center gap-2">
        {tabs.map((tab, index) => (
          <span
            key={tab}
            className={clsx(
              'rounded-full px-4 py-1.5 text-sm font-medium',
              index === 0
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-950'
                : 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-50 dark:ring-neutral-700',
            )}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className={PREVIEW_CARD}>
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {CHANNELS.map(channel => (
            <li key={channel.name} className="flex items-center gap-4 px-5 py-4">
              <SignalSourceLogo kind="telegram" className="h-9 w-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-neutral-900 dark:text-neutral-50">{channel.name}</p>
                <p className="text-xs text-neutral-900 dark:text-neutral-50">@{channel.username}</p>
              </div>
              <div className="flex items-center gap-2">
                {channel.brokers.map(broker => (
                  <span
                    key={broker.label}
                    className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-1 pe-3 ps-1.5 text-xs font-medium text-neutral-900 dark:bg-white/10 dark:text-neutral-50"
                  >
                    <img src={broker.icon} alt="" className="h-5 w-5 object-contain" />
                    {broker.label}
                  </span>
                ))}
              </div>
              <PreviewBadge tone={channel.active ? 'green' : 'neutral'}>
                {channel.active ? t.accountConfig.brokerList.statusActive : c.statusPaused}
              </PreviewBadge>
              <PreviewToggle on={channel.active} />
            </li>
          ))}
        </ul>
      </div>
    </AppPreviewWindow>
  )
}
