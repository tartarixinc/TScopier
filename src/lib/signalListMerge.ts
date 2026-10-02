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
