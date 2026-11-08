import { RefreshCw, Search, Trash2 } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import {
  AppPreviewWindow,
  PREVIEW_CARD,
  PreviewBadge,
  PreviewPageHeader,
  PreviewToggle,
} from './AppPreviewWindow'

type Row = {
  label: string
  broker: string
  login: string
  type: 'live' | 'demo' | 'prop'
  platform: string
  icon: string
  balance: string
  active: boolean
  healthy: boolean
}

const ROWS: readonly Row[] = [
  { label: 'Live MT5', broker: 'Fusion Markets', login: '4821937', type: 'live', platform: 'MT5', icon: '/MT5.png', balance: '$48,331.20', active: true, healthy: true },
  { label: 'Prop Challenge', broker: 'FTMO', login: '1052248', type: 'prop', platform: 'MT4', icon: '/MT4.png', balance: '$100,000.00', active: true, healthy: true },
  { label: 'Crypto Futures', broker: 'Binance', login: 'USD-M', type: 'live', platform: 'Binance', icon: '/Binance.png', balance: '$12,904.55', active: true, healthy: true },
  { label: 'cTrader Demo', broker: 'IC Markets', login: '9035512', type: 'demo', platform: 'cTrader', icon: '/cTrader.png', balance: '$25,000.00', active: false, healthy: true },
]

export function TradingAccountPreview() {
  const t = useT()
  const bl = t.accountConfig.brokerList
  const typeLabel = (type: Row['type']) =>
    type === 'live' ? bl.accountTypeLive : type === 'demo' ? bl.accountTypeDemo : bl.accountTypePropFirm
  const typeClass = (type: Row['type']) =>
    type === 'live'
      ? 'text-green-600 dark:text-green-400'
      : type === 'demo'
        ? 'text-sky-600 dark:text-sky-400'
        : 'text-amber-600 dark:text-amber-400'

  return (
    <AppPreviewWindow activeRoute="/brokers">
      <PreviewPageHeader
        title={t.pages.accountConfiguration.title}
        action={t.accountConfig.connectForm.addAccountButton}
      />
      <div className={PREVIEW_CARD}>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-72 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50">
            <Search className="h-4 w-4" />
            <span className="truncate">{t.globalSearch.placeholder}</span>
          </div>
          <div className="flex h-9 w-44 items-center rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50">
            {bl.platformFilterAll}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-neutral-100 text-left text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
              <th className="px-4 py-3 font-medium">{bl.colName}</th>
              <th className="px-3 py-3 font-medium">{bl.colAccount}</th>
              <th className="px-3 py-3 font-medium">{bl.colPlatform}</th>
              <th className="px-3 py-3 font-medium">{bl.colBalance}</th>
              <th className="px-3 py-3 font-medium">{bl.colConnection}</th>
              <th className="px-3 py-3 font-medium">{bl.colStatus}</th>
              <th className="px-4 py-3 text-end font-medium">{bl.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(row => (
              <tr key={row.label} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="px-4 py-3">
                  <p className="font-medium text-neutral-900 dark:text-neutral-50">{row.label}</p>
                  <p className="mt-0.5 text-xs text-neutral-900 dark:text-neutral-50">{row.broker}</p>
                </td>
                <td className="px-3 py-3">
                  <p className="text-neutral-900 dark:text-neutral-100">{row.login}</p>
                  <p className={`mt-0.5 text-xs ${typeClass(row.type)}`}>{typeLabel(row.type)}</p>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <img src={row.icon} alt="" className="h-7 w-7 object-contain" />
                    <span className="text-neutral-900 dark:text-neutral-100">{row.platform}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{row.balance}</td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-1.5">
                    <PreviewBadge>{bl.statusConnected}</PreviewBadge>
                    <PreviewBadge tone="blue">{bl.statusHealthy}</PreviewBadge>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-medium ${row.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-900 dark:text-neutral-50'}`}
                    >
                      {row.active ? bl.statusActive : bl.statusInactive}
                    </span>
                    <PreviewToggle on={row.active} />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-900 dark:border-neutral-700 dark:text-neutral-50">
                      <RefreshCw className="h-3.5 w-3.5" />
                      {bl.reconnect}
                    </span>
                    <span className="rounded-lg bg-green-400 px-3 py-1.5 text-xs font-medium text-neutral-950">
                      {bl.configure}
                    </span>
                    <Trash2 className="h-4 w-4 text-neutral-900 dark:text-neutral-50" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppPreviewWindow>
  )
}
