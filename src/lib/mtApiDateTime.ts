/** `yyyy-MM-ddTHH:mm:ss` in local time (matches MT API query params, not UTC-shifted). */
export function formatLocalMtApiDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function epochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value
}

/**
 * Parse MT close/open timestamps. Supports ISO strings, naive local datetimes,
 * unix seconds/ms (number or numeric string), and falls back like `new Date()`.
 */
export function parseMtHistoryTimestamp(
  iso: string | number | null | undefined,
): number | null {
  if (iso == null || iso === '') return null
  if (typeof iso === 'number' && Number.isFinite(iso)) {
    return epochMs(iso)
  }

  const s = String(iso).trim()
  if (!s) return null

  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return epochMs(n)
  }

  const normalizedDots = s.replace(/\./g, '-')
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalizedDots)) {
    const t = Date.parse(normalizedDots)
    return Number.isFinite(t) ? t : null
  }

  const normalized = normalizedDots.includes('T')
    ? normalizedDots
    : normalizedDots.replace(' ', 'T')
  const parsed = Date.parse(normalized)
  if (Number.isFinite(parsed)) return parsed

  const fallback = Date.parse(s)
  return Number.isFinite(fallback) ? fallback : null
}

export function isMtTimestampInRange(
  iso: string | number | null | undefined,
  start: Date,
  end: Date,
): boolean {
  const ts = parseMtHistoryTimestamp(iso)
  if (ts == null) return false
  return ts >= start.getTime() && ts < end.getTime()
}

/** Coerce API timestamp fields (string, number, or null) to a string for chart rows. */
export function coerceMtTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(epochMs(value)).toISOString()
  }
  const s = String(value).trim()
  return s || null
}
