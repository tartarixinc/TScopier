import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import {
  AppPreviewWindow,
  PREVIEW_CARD,
  PreviewBadge,
  PreviewPageHeader,
  PreviewToggle,
} from './AppPreviewWindow'

type Slave = { label: string; icon: string; balance: string; risk: 'fixed' | 'percent'; setting: string; active: boolean }
type Group = {
  master: { label: string; icon: string; login: string; balance: string }
  slaves: readonly Slave[]
}

const GROUPS: readonly Group[] = [
  {
    master: { label: 'Gold Master', icon: '/MT5.png', login: '4821937', balance: '$48,331.20' },
    slaves: [
      { label: 'Prop Challenge', icon: '/MT4.png', balance: '$100,000.00', risk: 'fixed', setting: '0.50 lots', active: true },
      { label: 'Client Account', icon: '/MT5.png', balance: '$21,480.00', risk: 'percent', setting: '2.0%', active: true },
      { label: 'cTrader Demo', icon: '/cTrader.png', balance: '$25,000.00', risk: 'fixed', setting: '0.10 lots', active: false },
    ],
  },
  {
    master: { label: 'Crypto Master', icon: '/Binance.png', login: 'USD-M', balance: '$12,904.55' },
    slaves: [
      { label: 'Bybit Futures', icon: '/Bybit.png', balance: '$8,210.00', risk: 'percent', setting: '1.5%', active: true },
    ],
  },
]

export function MirrorAccountPreview() {
  const t = useT()
  const c = t.mirrorTradingPage

  return (
    <AppPreviewWindow activeRoute="/mirror-trading">
      <PreviewPageHeader title={c.title} action={c.addMaster} />
      <div className={PREVIEW_CARD}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
              <th className="px-4 py-3">{c.colAccount}</th>
              <th className="px-3 py-3">{c.colCopyFrom}</th>
              <th className="px-3 py-3">{c.colRiskType}</th>
              <th className="px-3 py-3">{c.colRiskSetting}</th>
              <th className="px-3 py-3">{c.colStatus}</th>
              <th className="px-4 py-3">{c.colActions}</th>
            </tr>
          </thead>
          {GROUPS.map(group => (
            <tbody key={group.master.label}>
              <tr className="border-b border-neutral-100 bg-neutral-50/70 dark:border-neutral-800 dark:bg-white/[0.03]">
                <td className="px-4 py-3" colSpan={2}>
                  <div className="flex items-center gap-2">
                    <ChevronDown className="h-4 w-4 text-neutral-900 dark:text-neutral-50" />
                    <img src={group.master.icon} alt="" className="h-7 w-7 object-contain" />
                    <div>
                      <p className="font-medium text-neutral-900 dark:text-neutral-50">{group.master.label}</p>
                      <p className="text-xs text-neutral-900 dark:text-neutral-50">
                        {c.login}: {group.master.login} · {c.balance}: {group.master.balance}
                      </p>
                    </div>
                    <PreviewBadge tone="amber">{c.master}</PreviewBadge>
                  </div>
                </td>
                <td className="px-3 py-3" colSpan={2} />
                <td className="px-3 py-3">
                  <PreviewToggle />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-900 dark:border-neutral-700 dark:text-neutral-50">
                      <Plus className="h-3.5 w-3.5" />
                      {c.addSlave}
                    </span>
                    <Trash2 className="h-4 w-4 text-neutral-900 dark:text-neutral-50" />
                  </div>
                </td>
              </tr>
              {group.slaves.map(slave => (
                <tr key={slave.label} className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-3 pe-3 ps-10">
                    <div className="flex items-center gap-2">
                      <img src={slave.icon} alt="" className="h-6 w-6 object-contain" />
                      <div>
                        <p className="font-medium text-neutral-900 dark:text-neutral-50">{slave.label}</p>
                        <p className="text-xs text-neutral-900 dark:text-neutral-50">{c.balance}: {slave.balance}</p>
                      </div>
                      <PreviewBadge tone="blue">{c.slave}</PreviewBadge>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{group.master.label}</td>
                  <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">
                    {slave.risk === 'fixed' ? c.riskFixedLot : c.riskBalancePercent}
                  </td>
                  <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{slave.setting}</td>
                  <td className="px-3 py-3">
                    <PreviewToggle on={slave.active} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded-lg bg-green-400 px-3 py-1.5 text-xs font-medium text-neutral-950">
                        {c.configure}
                      </span>
                      <Trash2 className="h-4 w-4 text-neutral-900 dark:text-neutral-50" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </AppPreviewWindow>
  )
}
