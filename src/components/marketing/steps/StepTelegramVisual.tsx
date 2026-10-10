import clsx from 'clsx'
import { Plus } from 'lucide-react'
import { Badge } from '../../ui/Badge'
import { Toggle } from '../../ui/Toggle'
import { useT } from '../../../context/LocaleContext'

export function StepTelegramVisual() {
  const t = useT()
  const ce = t.copierEnginePage
  const v = t.landing.steps.visuals.telegram

  return (
    <div className="flex h-full min-h-[220px] items-stretch p-3 sm:p-4">
      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-neutral-200/65 bg-white shadow-sm dark:border-neutral-800/55 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 bg-gradient-to-br from-[#229ED9]/12 via-sky-50/90 to-white px-4 py-3 dark:border-neutral-800 dark:from-[#229ED9]/20 dark:via-sky-950/30 dark:to-neutral-900">
          <div className="flex items-center gap-2">
            <img src="/Telegram.svg" alt="" className="h-7 w-7 object-contain" aria-hidden />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-50">{ce.tgConnectHeroTitle}</p>
              <p className="truncate text-[10px] text-neutral-500 dark:text-neutral-400">{ce.telegramConnectedHint}</p>
            </div>
          </div>
        </div>

        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {v.channels.map((channel) => (
            <div key={channel.username}>
              <div className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary-50 dark:bg-primary-950/40">
                  <img src="/Telegram.svg" alt="" className="h-5 w-5 object-contain" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-50">
                    {channel.name}
                  </p>
                  <p className="text-[10px] text-neutral-500 dark:text-neutral-400">@{channel.username}</p>
                </div>
                <Toggle checked={channel.active} onChange={() => {}} disabled />
              </div>
              <div className="space-y-1.5 border-t border-neutral-100 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-800/60 sm:px-4">
                <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                  {ce.connectedBrokers}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  {channel.brokers.map((broker) => (
                    <Badge key={broker} variant="neutral" size="sm">
                      {broker}
                    </Badge>
                  ))}
                  <span
                    className={clsx(
                      'inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200',
                      'text-neutral-500 dark:border-neutral-700',
                    )}
                    aria-hidden
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
