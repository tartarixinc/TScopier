/** `yyyy-MM-ddTHH:mm:ss` in local time (matches MT API query params, not UTC-shifted). */
export function formatLocalMtApiDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Parse MT close/open timestamps. Naive `yyyy-MM-ddTHH:mm:ss` strings are treated as local time.
 */
export function parseMtHistoryTimestamp(iso: string | null | undefined): number | null {
  if (!iso?.trim()) return null
  const s = iso.trim().replace(/\./g, '-')
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  const t = Date.parse(normalized)
  return Number.isFinite(t) ? t : null
}

export function isMtTimestampInRange(
  iso: string | null | undefined,
  start: Date,
  end: Date,
): boolean {
  const ts = parseMtHistoryTimestamp(iso)
  if (ts == null) return false
  return ts >= start.getTime() && ts < end.getTime()
}
