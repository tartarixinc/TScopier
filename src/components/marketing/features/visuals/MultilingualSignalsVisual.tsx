import clsx from 'clsx'
import { Check, Languages } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'
import { LocaleFlag } from '../../../ui/LocaleFlag'

function SignalCard({
  flagId,
  language,
  message,
  parsedAction,
  side,
  parsedLabel,
  elevated,
}: {
  flagId: string
  language: string
  message: string
  parsedAction: string
  side: 'buy' | 'sell'
  parsedLabel: string
  elevated?: boolean
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-neutral-200/90 bg-white/95 px-3.5 py-3 shadow-sm backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/95',
        elevated && 'shadow-md ring-1 ring-teal-500/10 dark:ring-teal-400/10',
      )}
    >
      <div className="flex items-center gap-2">
        <LocaleFlag flagId={flagId} className="h-3.5 w-[1.3125rem]" title={language} />
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{language}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
          <Check className="h-2.5 w-2.5" aria-hidden />
          {parsedLabel}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {message}
      </p>
      <p
        className={clsx(
          'mt-1.5 text-sm font-semibold tracking-tight',
          side === 'buy'
            ? 'text-primary-600 dark:text-teal-400'
            : 'text-amber-600 dark:text-amber-400',
        )}
      >
        {parsedAction}
      </p>
    </div>
  )
}

export function MultilingualSignalsVisual() {
  const v = useT().landing.features.visuals.multilingual

  return (
    <div className="relative flex h-full min-h-[300px] items-center justify-center overflow-hidden p-3 sm:p-5">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(20,184,166,0.12),transparent_55%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(45,212,191,0.08),transparent_55%)]"
        aria-hidden
      />

      <div className="relative w-full max-w-md space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200/80 bg-white/90 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/90">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              <Languages className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
                {v.languagesBadge}
              </p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{v.moreLanguages}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {v.ribbonFlags.map((flagId) => (
              <LocaleFlag
                key={flagId}
                flagId={flagId}
                className="h-3 w-[1.125rem] shadow-sm"
              />
            ))}
          </div>
        </div>

        <div className="space-y-2.5">
          {v.signals.map((signal, index) => (
            <div
              key={`${signal.flagId}-${signal.language}`}
              className={clsx(index % 2 === 1 && 'sm:pl-6', index === 2 && 'sm:pr-6')}
            >
              <SignalCard
                flagId={signal.flagId}
                language={signal.language}
                message={signal.message}
                parsedAction={signal.parsedAction}
                side={signal.side}
                parsedLabel={v.parsedLabel}
                elevated={index === 1}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
