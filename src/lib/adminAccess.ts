export type AdminProfileFields = {
  is_admin?: boolean
  admin_until?: string | null
}

/** True when DB admin bypass is active (respects timed expiry). */
export function isAdminAccessActive(
  profile: AdminProfileFields | null | undefined,
): boolean {
  if (profile?.is_admin !== true) return false
  const until = profile.admin_until
  if (until == null || until === '') return true
  return new Date(until).getTime() > Date.now()
}

export function formatAdminUntilDisplay(
  isAdmin: boolean,
  adminUntil: string | null | undefined,
  locale?: string,
): string {
  if (!isAdmin) return '—'
  if (adminUntil == null || adminUntil === '') return '∞'
  const date = new Date(adminUntil)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Convert ISO timestamp to value for datetime-local input (local timezone). */
export function adminUntilToDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parse datetime-local input to ISO string (UTC). */
export function datetimeLocalValueToAdminUntil(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
