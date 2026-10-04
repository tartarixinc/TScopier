/**
 * Merge the newest-page signal rows with fallback rows for open/pending trades
 * whose signals fell outside the page limit. The loaded page is ordered newest
 * first and fallbacks are older, so appending keeps the ordering. Duplicate ids
 * keep the loaded row.
 */
export function mergeSignalsWithOpenFallbacks<T extends { id: string }>(
  loaded: readonly T[],
  fallbacks: readonly T[],
): T[] {
  if (fallbacks.length === 0) return [...loaded]
  const seen = new Set(loaded.map(row => row.id))
  const extras = fallbacks.filter(row => !seen.has(row.id))
  return extras.length > 0 ? [...loaded, ...extras] : [...loaded]
}

/**
 * Pin open signals to the top of the list, closed ones after them. Each group
 * keeps the order it arrived in (newest first) — Array.prototype.sort is
 * stable, so no second sort is needed. Same rule the trades list already
 * follows: the signals a customer can still act on must not sit below
 * hundreds of closed ones.
 */
export function pinOpenSignalsFirst<T extends { openStatus: 'open' | 'closed' }>(
  rows: readonly T[],
): T[] {
  if (rows.length < 2) return [...rows]
  return [...rows].sort((a, b) => Number(b.openStatus === 'open') - Number(a.openStatus === 'open'))
}
