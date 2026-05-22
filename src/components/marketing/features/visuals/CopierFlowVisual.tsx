import { Layers, Radio, Scale } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'

export function CopierFlowVisual() {
  const v = useT().landing.features.visuals.copier

  return (
    <div className="relative flex h-full min-h-[280px] items-center justify-center">
      <div className="marketing-feature-pulse-ring" aria-hidden />
      <div className="marketing-feature-flow relative flex w-full max-w-md flex-col items-center gap-5">
        <div className="marketing-feature-node marketing-feature-node--telegram z-10 w-full max-w-[220px]">
          <span className="marketing-feature-node-label">{v.telegramLabel}</span>
          <p className="mt-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {v.channelName}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{v.channelMeta}</p>
        </div>

        <div className="marketing-feature-hub z-10">
          <span className="text-sm font-semibold text-white">{v.hubLabel}</span>
        </div>

        <div className="relative z-10 flex w-full max-w-[320px] justify-center gap-4">
          <div className="marketing-feature-node marketing-feature-node--broker flex-1">
            <img src="/MT5.png" alt="" className="mx-auto h-8 w-8 object-contain" />
            <p className="mt-2 text-center text-xs font-semibold text-neutral-800 dark:text-neutral-100">
              {v.mt5Label}
            </p>
            <p className="text-center text-[10px] text-neutral-500">{v.mt5Meta}</p>
          </div>
          <div className="marketing-feature-node marketing-feature-node--broker flex-1">
            <img src="/MT4.png" alt="" className="mx-auto h-8 w-8 object-contain" />
            <p className="mt-2 text-center text-xs font-semibold text-neutral-800 dark:text-neutral-100">
              {v.mt4Label}
            </p>
            <p className="text-center text-[10px] text-neutral-500">{v.mt4Meta}</p>
          </div>
        </div>
      </div>

      <div className="marketing-feature-float marketing-feature-float--tl">
        <Layers className="h-3 w-3" aria-hidden />
        {v.pillLayering}
      </div>
      <div className="marketing-feature-float marketing-feature-float--tr">
        <Scale className="h-3 w-3" aria-hidden />
        {v.pillLots}
      </div>
      <div className="marketing-feature-float marketing-feature-float--bl">
        <Radio className="h-3 w-3" aria-hidden />
        {v.pillChannels}
      </div>
    </div>
  )
}
