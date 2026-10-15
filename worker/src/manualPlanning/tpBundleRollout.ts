/**
 * One-trade-per-TP bundling for multi-style accounts (env-gated, v1).
 *
 * Single switch: TP_BUNDLE_ENABLED. Anything that is not clearly true counts
 * as off, so an unset/invalid value always yields the classic multi split.
 * See docs/bundled-single-tp-trade-style.md.
 */

function parseStrictBoolean(value: string | undefined): boolean {
  if (value == null || value.trim() === '') return false
  const raw = value.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/** True when bundled legs (one trade per TP level) should be built for multi accounts. */
export function isTpBundleEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseStrictBoolean(env.TP_BUNDLE_ENABLED)
}
