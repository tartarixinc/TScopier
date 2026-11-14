/** Build Copier Log skipReasons maps from Channel Worker copy + locale overrides. */

function sentenceCase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/**
 * Prefer locale overrides, then Channel Worker translations (already localized),
 * then optional English catalog for keys neither source covers.
 */
export function buildCopierLogsSkipReasons(
  channelWorkerSkipReasons: Record<string, string> | undefined,
  overrides: Record<string, string> = {},
  englishFallback: Record<string, string> = {},
): Record<string, string> {
  const fromChannelWorker = Object.fromEntries(
    Object.entries(channelWorkerSkipReasons ?? {}).map(([key, value]) => [key, sentenceCase(value)]),
  )
  return {
    ...englishFallback,
    ...fromChannelWorker,
    ...overrides,
  }
}
