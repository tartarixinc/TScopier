interface BacktestRunOverlayProps {
  open: boolean
  message?: string | null
  progressPct?: number | null
}

/** Full-bleed overlay within the backtest page container (not the whole app shell). */
export function BacktestRunOverlay({ open, message, progressPct }: BacktestRunOverlayProps) {
  if (!open) return null

  const pct = progressPct != null && Number.isFinite(Number(progressPct))
    ? Math.min(100, Math.max(0, Number(progressPct)))
    : null

  const displayMessage =
    message?.trim()
    || 'Collating backtest results from Massive market data…'

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-white/85 dark:bg-neutral-950/90 backdrop-blur-sm"
      role="alert"
      aria-busy="true"
      aria-live="polite"
      aria-label="Backtest in progress"
    >
      <div className="flex flex-col items-center gap-5 px-6 text-center max-w-md">
        <div className="relative flex h-20 w-20 items-center justify-center" aria-hidden>
          <div className="absolute inset-0 rounded-full border-4 border-neutral-200/80 dark:border-neutral-700/80" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-teal-500 dark:border-t-teal-400 animate-spin" />
          {pct != null ? (
            <span className="text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
              {Math.round(pct)}%
            </span>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            Running backtest
          </p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
            {displayMessage}
          </p>
        </div>

        {pct != null ? (
          <div className="w-full max-w-xs">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-teal-500 dark:bg-teal-400 transition-[width] duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
