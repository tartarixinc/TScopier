/**
 * Parse a clamped numeric environment variable.
 *
 * `Number()` returns `NaN` for a malformed value ("abc", "", a stray unit),
 * and `Math.max(min, Math.min(max, NaN))` is still `NaN`. That value then
 * reaches `setTimeout(ms)` (fires immediately — the wait is silently dropped)
 * or an arithmetic comparison (`NaN > 0` is `false`, so a delay is skipped
 * entirely), turning a config typo into a missing cooldown, a missing timeout,
 * or a never-taken recovery path. Falling back to the documented default keeps
 * the code's intended behaviour instead of disabling it.
 */
export function envNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
