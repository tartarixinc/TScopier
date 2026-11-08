import clsx from 'clsx'
import { Card } from '../ui/Card'

function Bar({ className }: { className?: string }) {
  return <div className={clsx('rounded-md bg-neutral-200/90 dark:bg-white/8', className)} />
}

/** Full-page placeholder matching the social trader / own-provider profile layout. */
export function SocialTraderProfileSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx('animate-pulse space-y-4', className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="sr-only">Loading performance and trade history</p>

      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Bar className="h-14 w-14 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <Bar className="h-6 w-40 max-w-full" />
              <Bar className="h-4 w-56 max-w-full" />
              <Bar className="h-3 w-32" />
              <Bar className="mt-1 h-3 w-48 max-w-full" />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-4 sm:gap-8">
            <div className="space-y-2">
              <Bar className="h-3 w-20" />
              <Bar className="h-6 w-12" />
            </div>
            <div className="space-y-2">
              <Bar className="h-3 w-16" />
              <Bar className="h-6 w-14" />
            </div>
          </dl>
        </div>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <div className="flex gap-2">
            <Bar className="h-9 w-28 rounded-lg" />
            <Bar className="h-9 w-24 rounded-lg" />
            <Bar className="h-9 w-24 rounded-lg" />
          </div>

          <Card>
            <Bar className="h-4 w-36" />
            <div className="mt-5 flex h-48 items-end gap-2 sm:gap-3">
              {['h-[45%]', 'h-[62%]', 'h-[38%]', 'h-[78%]', 'h-[55%]', 'h-[70%]'].map((height, i) => (
                <Bar key={i} className={clsx('w-full rounded-t-md', height)} />
              ))}
            </div>
            <div className="mt-3 flex justify-between gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Bar key={i} className="h-3 w-8" />
              ))}
            </div>
          </Card>

          <Card>
            <Bar className="h-4 w-28" />
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Bar className="h-3 w-20" />
                  <Bar className="h-5 w-16" />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="flex items-baseline justify-between gap-2">
              <Bar className="h-4 w-28" />
              <Bar className="h-3 w-24" />
            </div>
            <div className="mt-4 grid grid-cols-7 gap-2">
              {Array.from({ length: 28 }, (_, i) => (
                <Bar key={i} className="min-h-[56px] rounded-lg sm:min-h-[72px]" />
              ))}
            </div>
          </Card>
        </div>

        <Card className="xl:sticky xl:top-4">
          <Bar className="h-4 w-24" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Bar className="h-6 w-16" />
              <Bar className="h-3 w-20" />
            </div>
            <div className="space-y-2">
              <Bar className="h-6 w-16" />
              <Bar className="h-3 w-24" />
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <Bar className="h-3.5 w-24" />
                <Bar className="h-3.5 w-14" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
