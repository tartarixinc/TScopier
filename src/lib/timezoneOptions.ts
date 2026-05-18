export interface SelectOption {
  value: string
  label: string
}

/** Windows-style friendly names for common IANA zones. */
const ZONE_ALIASES: Record<string, string> = {
  'Pacific/Midway': 'Midway Island, Samoa',
  'Pacific/Honolulu': 'Hawaii',
  'America/Anchorage': 'Alaska',
  'America/Los_Angeles': 'Pacific Time (US & Canada)',
  'America/Tijuana': 'Baja California',
  'America/Denver': 'Mountain Time (US & Canada)',
  'America/Chicago': 'Central Time (US & Canada)',
  'America/New_York': 'Eastern Time (US & Canada)',
  'America/Halifax': 'Atlantic Time (Canada)',
  'America/Sao_Paulo': 'Brasilia',
  'Atlantic/Azores': 'Azores',
  'Europe/London': 'London, Edinburgh, Dublin',
  'Europe/Paris': 'Brussels, Copenhagen, Madrid, Paris',
  'Europe/Berlin': 'Amsterdam, Berlin, Rome, Stockholm, Vienna',
  'Europe/Athens': 'Athens, Bucharest, Istanbul',
  'Europe/Moscow': 'Moscow, St. Petersburg',
  'Asia/Dubai': 'Abu Dhabi, Muscat',
  'Asia/Kolkata': 'Chennai, Kolkata, Mumbai, New Delhi',
  'Asia/Bangkok': 'Bangkok, Hanoi, Jakarta',
  'Asia/Singapore': 'Kuala Lumpur, Singapore',
  'Asia/Shanghai': 'Beijing, Chongqing, Hong Kong',
  'Asia/Tokyo': 'Osaka, Sapporo, Tokyo',
  'Australia/Sydney': 'Canberra, Melbourne, Sydney',
  'Pacific/Auckland': 'Auckland, Wellington',
  'Etc/UTC': 'Coordinated Universal Time',
  UTC: 'Coordinated Universal Time',
}

const FALLBACK_TIMEZONES = [
  'UTC',
  'Etc/GMT+12',
  'Pacific/Midway',
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Atlantic/Azores',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

function getAllTimeZoneIds(): string[] {
  try {
    if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
      return [...Intl.supportedValuesOf('timeZone')].sort()
    }
  } catch {
    /* ignore */
  }
  return [...FALLBACK_TIMEZONES]
}

/** Offset in minutes east of UTC at the given instant. */
export function getTimezoneOffsetMinutes(timeZone: string, at = new Date()): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const parts = dtf.formatToParts(at)
    const filled: Record<string, string> = {}
    for (const p of parts) {
      if (p.type !== 'literal') filled[p.type] = p.value
    }
    const asUtc = Date.UTC(
      Number(filled.year),
      Number(filled.month) - 1,
      Number(filled.day),
      Number(filled.hour),
      Number(filled.minute),
      Number(filled.second),
    )
    return Math.round((asUtc - at.getTime()) / 60_000)
  } catch {
    return 0
  }
}

/** e.g. -05:00 or +05:30 (sign included). */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatZoneDisplayName(timeZone: string): string {
  if (ZONE_ALIASES[timeZone]) return ZONE_ALIASES[timeZone]
  if (timeZone.startsWith('Etc/GMT')) {
    return timeZone.replace('Etc/', '').replace('GMT', 'UTC')
  }
  const segments = timeZone.split('/')
  const city = segments[segments.length - 1]?.replace(/_/g, ' ') ?? timeZone
  if (segments.length >= 3) {
    const region = segments[1]?.replace(/_/g, ' ')
    return `${city}, ${region}`
  }
  return city
}

export function buildTimezoneOptions(at = new Date()): SelectOption[] {
  const zones = getAllTimeZoneIds()
  const rows = zones.map(timeZone => {
    const offsetMinutes = getTimezoneOffsetMinutes(timeZone, at)
    const offset = formatUtcOffset(offsetMinutes)
    const name = formatZoneDisplayName(timeZone)
    return {
      value: timeZone,
      label: `(UTC${offset}) ${name}`,
      offsetMinutes,
    }
  })

  rows.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label))
  return rows.map(({ value, label }) => ({ value, label }))
}

/** Built once per page load (offsets reflect current DST rules). */
export const TIMEZONE_OPTIONS: SelectOption[] = buildTimezoneOptions()

export function findTimezoneLabel(value: string): string {
  return TIMEZONE_OPTIONS.find(o => o.value === value)?.label ?? value
}
