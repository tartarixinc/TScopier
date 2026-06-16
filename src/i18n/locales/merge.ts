import type { Translations } from './types'

/** Overlay translated modules onto the English bundle for incremental locale rollout. */
export function mergeLocaleBundle(
  base: Translations,
  overrides: Partial<Translations>,
): Translations {
  return { ...base, ...overrides }
}
