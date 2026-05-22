import { Activity, Clock } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'

export function CopierLogsVisual() {
  const v = useT().landing.features.visuals.logs

  return (
    <div className="relative flex h-full min-h-[280px] items-center justify-center p-2">
      <div className="w-full max-w-sm">
        <div className="marketing-feature-hub mx-auto mb-6 w-fit px-5">
          <span className="text-sm font-semibold text-white">{v.hubLabel}</span>
        </div>

        <div className="space-y-2">
          {v.entries.map((entry, i) => (
            <div
              key={entry.stage}
              className="marketing-feature-log-row relative rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/80"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                    {entry.stage}
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-neutral-900 dark:text-neutral-50">
                    {entry.message}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs font-semibold text-neutral-500 dark:text-neutral-400">
                  {entry.latency}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="marketing-feature-float marketing-feature-float--bl">
          <Clock className="h-3 w-3" aria-hidden />
          {v.pillLatency}
        </div>
        <div className="marketing-feature-float marketing-feature-float--br">
          <Activity className="h-3 w-3" aria-hidden />
          {v.pillLive}
        </div>
      </div>
    </div>
  )
}
