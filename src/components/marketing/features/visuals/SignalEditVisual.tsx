import { ArrowDown, Pencil } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'

export function SignalEditVisual() {
  const v = useT().landing.features.visuals.signalEdit

  return (
    <div className="flex h-full min-h-[300px] items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-md space-y-3">
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                {v.channelName}
              </p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{v.channelMeta}</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              <Pencil className="h-3 w-3" aria-hidden />
              {v.editedLabel}
            </span>
          </div>

          <div className="space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-primary-600 dark:text-teal-400">{v.messageBuy}</p>

            <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/80 px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-800/40">
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                {v.beforeLabel}
              </p>
              <p className="mt-1 text-xs text-neutral-500 line-through decoration-neutral-400 dark:text-neutral-400">
                {v.beforeSl} · {v.beforeTp}
              </p>
            </div>

            <div className="flex justify-center text-neutral-300 dark:text-neutral-600">
              <ArrowDown className="h-4 w-4" aria-hidden />
            </div>

            <div className="rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2.5 dark:border-teal-900/60 dark:bg-teal-950/30">
              <p className="text-[10px] font-medium uppercase tracking-wide text-teal-700 dark:text-teal-400">
                {v.afterLabel}
              </p>
              <p className="mt-1 text-xs font-medium text-neutral-900 dark:text-neutral-100">
                {v.afterSl} · {v.afterTp}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            {v.workerTitle}
          </p>
          <p className="mt-1 text-sm text-neutral-800 dark:text-neutral-100">{v.workerMessage}</p>
          <p className="mt-1 text-[11px] text-neutral-400">{v.workerTime}</p>
        </div>
      </div>
    </div>
  )
}
