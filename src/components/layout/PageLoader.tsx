/** Lightweight fallback while a lazy route chunk loads. */
export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent"
        aria-label="Loading"
      />
    </div>
  )
}
