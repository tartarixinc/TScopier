export function MarketNewsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <div className="grid md:grid-cols-2">
          <div className="aspect-[16/10] bg-neutral-200 dark:bg-neutral-800 md:min-h-[280px]" />
          <div className="space-y-4 p-6 lg:p-8">
            <div className="h-5 w-24 rounded-full bg-neutral-200 dark:bg-neutral-800" />
            <div className="h-8 w-full rounded bg-neutral-200 dark:bg-neutral-800" />
            <div className="h-8 w-4/5 rounded bg-neutral-200 dark:bg-neutral-800" />
            <div className="space-y-2">
              <div className="h-4 w-full rounded bg-neutral-100 dark:bg-neutral-800/80" />
              <div className="h-4 w-full rounded bg-neutral-100 dark:bg-neutral-800/80" />
              <div className="h-4 w-2/3 rounded bg-neutral-100 dark:bg-neutral-800/80" />
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800"
          >
            <div className="aspect-[16/9] bg-neutral-200 dark:bg-neutral-800" />
            <div className="space-y-3 p-4">
              <div className="h-3 w-1/3 rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-4 w-full rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-4 w-5/6 rounded bg-neutral-100 dark:bg-neutral-800/80" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
