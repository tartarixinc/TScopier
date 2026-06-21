export function StatBlock({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-neutral-900 dark:text-neutral-100">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{sub}</p> : null}
    </div>
  )
}
