export function displayUserName(profile: {
  first_name?: string
  last_name?: string
  display_name?: string
}): string {
  const first = String(profile.first_name ?? '').trim()
  const last = String(profile.last_name ?? '').trim()
  const combined = [first, last].filter(Boolean).join(' ')
  if (combined) return combined
  const display = String(profile.display_name ?? '').trim()
  return display || 'Unnamed user'
}

export function formatJoinedDate(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatAdminUntil(isAdmin: boolean, adminUntil: string | null | undefined): string {
  if (!isAdmin) return '—'
  if (adminUntil == null || adminUntil === '') return '∞'
  const date = new Date(adminUntil)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function adminUntilToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function datetimeLocalToIso(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
