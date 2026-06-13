export function CopierActiveIndicator() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0 sm:h-3 sm:w-3" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-60" />
      <span className="relative inline-flex h-full w-full rounded-full bg-teal-500 dark:bg-teal-400" />
    </span>
  )
}
