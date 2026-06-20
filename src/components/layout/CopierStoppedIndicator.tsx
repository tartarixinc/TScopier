/** Static red dot for locked copier-stopped state (no user pause). */
export function CopierStoppedIndicator() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0 sm:h-3 sm:w-3" aria-hidden>
      <span className="relative inline-flex h-full w-full rounded-full bg-error-500 dark:bg-error-400" />
    </span>
  )
}
