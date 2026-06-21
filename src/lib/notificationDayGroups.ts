const DAY_MS = 86_400_000

function startOfLocalDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function parseDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return new Date(y, m - 1, d)
}

/** Local calendar day key (YYYY-MM-DD) for grouping. */
export function localDayKey(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) {
    const fallback = startOfLocalDay(now)
    return formatDayKey(fallback)
  }
  return formatDayKey(d)
}

function formatDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface NotificationDayLabelOptions {
  today: string
  yesterday: string
  locale: string
  now?: Date
}

export function formatNotificationDayLabel(
  dayKey: string,
  opts: NotificationDayLabelOptions,
): string {
  const date = parseDayKey(dayKey)
  const now = opts.now ?? new Date()
  if (!date) return dayKey

  const diffDays = Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) / DAY_MS,
  )
  if (diffDays === 0) return opts.today
  if (diffDays === 1) return opts.yesterday
  if (diffDays < 7) {
    return date.toLocaleDateString(opts.locale, { weekday: 'long' })
  }
  return date.toLocaleDateString(opts.locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

export interface NotificationDayGroup<T> {
  dayKey: string
  label: string
  items: T[]
}

export function groupNotificationsByDay<T extends { createdAt: string }>(
  items: T[],
  opts: NotificationDayLabelOptions,
): NotificationDayGroup<T>[] {
  const buckets = new Map<string, T[]>()
  const order: string[] = []

  for (const item of items) {
    const key = localDayKey(item.createdAt, opts.now)
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    buckets.get(key)!.push(item)
  }

  return order.map(dayKey => ({
    dayKey,
    label: formatNotificationDayLabel(dayKey, opts),
    items: buckets.get(dayKey) ?? [],
  }))
}
