import clsx from 'clsx'

const CARD =
  'rounded-2xl border border-neutral-200/65 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-neutral-800/55 dark:bg-neutral-950 dark:shadow-none'

const COPIER_LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4rem,0.85fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

export function isDashboardBootPath(pathname: string) {
  return pathname === '/' || pathname === '/dashboard' || pathname.startsWith('/dashboard/')
}

function SkeletonBar({ className }: { className?: string }) {
  return <div className={clsx('rounded-md bg-neutral-200/90 dark:bg-white/[0.08]', className)} />
}

export function DashboardMetricsSkeleton({ message }: { message?: string }) {
  const volumeBars = [42, 78, 34, 92, 56, 70, 38]
  const channelBars = ['72%', '48%', '86%', '34%', '60%']

  return (
    <div className="animate-pulse space-y-8" role="status" aria-live="polite" aria-busy="true">
      {message ? <p className="sr-only">{message}</p> : <p className="sr-only">Loading</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="rounded-2xl bg-[#F7F8FA] px-4 py-4 sm:px-5 dark:bg-white/[0.03] dark:ring-1 dark:ring-inset dark:ring-white/[0.06]"
          >
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="mt-3 h-7 w-28" />
            <SkeletonBar className="mt-2.5 h-3 w-32" />
          </div>
        ))}
      </div>

      <div className={`${CARD} grid grid-cols-2 divide-x divide-y divide-neutral-100 dark:divide-neutral-800/70 lg:grid-cols-4 lg:divide-y-0`}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="px-4 py-4 sm:px-5">
            <SkeletonBar className="h-3 w-28" />
            <SkeletonBar className="mt-3 h-6 w-10" />
            {i % 2 === 0 ? <SkeletonBar className="mt-3 h-3 w-24" /> : <span className="mt-3 block h-3" />}
          </div>
        ))}
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <SkeletonBar className="h-4 w-4 shrink-0 rounded" />
          <SkeletonBar className="h-4 w-28" />
          <span className="flex-1" />
          <SkeletonBar className="h-4 w-4 shrink-0 rounded" />
        </div>
        <div className="px-5 py-4">
          <SkeletonBar className="h-4 w-3/5 max-w-sm" />
          <SkeletonBar className="mt-2 h-3 w-40" />
          <div className="mt-4 grid sm:grid-cols-2 sm:gap-x-10">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-2.5">
                <SkeletonBar className="h-3.5 w-36 max-w-[60%]" />
                <SkeletonBar className="h-3.5 w-16" />
              </div>
            ))}
          </div>
          <SkeletonBar className="mt-3 h-4 w-28" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
        <div className={`${CARD} p-5`}>
          <SkeletonBar className="h-4 w-40" />
          <SkeletonBar className="mt-2 h-3 w-56 max-w-full" />
          <div className="mt-5 flex h-64 items-end gap-2 rounded-xl bg-[#F7F8FA] px-4 pb-6 pt-8 dark:bg-white/[0.03]">
            {volumeBars.map((height, i) => (
              <div key={i} className="flex h-full flex-1 items-end gap-1">
                <div
                  className="w-1/2 rounded-t-md bg-neutral-200/90 dark:bg-white/[0.08]"
                  style={{ height: `${Math.max(18, height - 22)}%` }}
                />
                <div
                  className="w-1/2 rounded-t-md bg-teal-600/25 dark:bg-teal-400/25"
                  style={{ height: `${height}%` }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className={`${CARD} p-5`}>
          <SkeletonBar className="h-4 w-44" />
          <SkeletonBar className="mt-2 h-3 w-48 max-w-full" />
          <div className="mt-5 flex h-64 flex-col justify-between rounded-xl bg-[#F7F8FA] px-4 py-5 dark:bg-white/[0.03]">
            {channelBars.map((width, i) => (
              <div key={i} className="flex items-center gap-3">
                <SkeletonBar className="h-3 w-16 shrink-0" />
                <div className="h-3.5 min-w-0 flex-1">
                  <div
                    className="h-full rounded-r-md bg-teal-600/25 dark:bg-teal-400/25"
                    style={{ width }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
        <div className={`${CARD} min-w-0 overflow-hidden`}>
          <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
            <SkeletonBar className="h-4 w-32" />
            <SkeletonBar className="h-3 w-20" />
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="px-5 py-3">
                <SkeletonBar className="h-4 w-3/4" />
                <SkeletonBar className="mt-1.5 h-3 w-1/3" />
              </div>
            ))}
          </div>
        </div>

        <div className={`${CARD} min-w-0 overflow-hidden`}>
          <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
            <SkeletonBar className="h-4 w-28" />
            <SkeletonBar className="h-3 w-16" />
          </div>
          <div className="overflow-x-auto">
            <div className={`${COPIER_LOG_GRID} min-w-[28rem] border-b border-neutral-100 px-5 py-2.5 dark:border-neutral-800/80`}>
              {Array.from({ length: 5 }, (_, i) => (
                <SkeletonBar key={i} className="h-3 w-12" />
              ))}
            </div>
            <div className="min-w-[28rem] divide-y divide-neutral-100 dark:divide-neutral-800">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className={`${COPIER_LOG_GRID} px-5 py-3`}>
                  <SkeletonBar className="h-5 w-16 rounded-full" />
                  <SkeletonBar className="h-3.5 w-full" />
                  <SkeletonBar className="h-4 w-14" />
                  <SkeletonBar className="h-3.5 w-10" />
                  <SkeletonBar className="ml-auto h-3 w-16" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
          <SkeletonBar className="h-4 w-36" />
          <SkeletonBar className="h-3 w-12" />
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[52rem] lg:min-w-0">
            <div className="grid grid-cols-9 gap-2 border-b border-neutral-100 px-5 py-2.5 dark:border-neutral-800/80">
              {Array.from({ length: 9 }, (_, i) => (
                <SkeletonBar key={i} className={clsx('h-3', i === 8 ? 'ml-auto w-12' : 'w-14')} />
              ))}
            </div>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="grid grid-cols-9 items-center gap-2 px-5 py-3.5">
                  <div className="space-y-1.5">
                    <SkeletonBar className="h-4 w-24" />
                    <SkeletonBar className="h-3 w-16" />
                  </div>
                  {Array.from({ length: 8 }, (_, j) => (
                    <SkeletonBar key={j} className={clsx('h-4', j === 7 ? 'ml-auto w-14 rounded-full' : 'w-12')} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Dashboard content while the page chunk is still loading, inside the real app shell. */
export function DashboardRouteSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-8 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
      <div className="h-9 w-72 max-w-full animate-pulse rounded-md bg-neutral-200/90 dark:bg-white/[0.08]" />
      <DashboardMetricsSkeleton />
    </div>
  )
}

/** Full-screen stand-in used before the app shell is mounted on refresh. */
export function DashboardBootSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 overflow-hidden bg-white dark:bg-neutral-950"
      role="status"
      aria-busy="true"
    >
      <aside className="hidden h-full w-64 shrink-0 flex-col border-e border-neutral-100 bg-[#F7F8FA] dark:border-neutral-800 dark:bg-neutral-950 lg:flex">
        <div className="flex h-16 items-center border-b border-neutral-100 px-4 dark:border-neutral-800">
          <div className="h-6 w-28 animate-pulse rounded-md bg-neutral-200/90 dark:bg-white/[0.08]" />
        </div>
        <div className="space-y-2 px-3 py-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className={clsx(
                'h-9 animate-pulse rounded-lg bg-neutral-200/80 dark:bg-white/[0.06]',
                i === 0 ? 'w-full' : 'w-[88%]',
              )}
            />
          ))}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-neutral-100 px-4 dark:border-neutral-800 sm:h-16 sm:px-6">
          <div className="h-9 w-full max-w-md animate-pulse rounded-lg bg-neutral-200/90 dark:bg-white/[0.08]" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DashboardRouteSkeleton />
        </div>
      </div>
    </div>
  )
}
