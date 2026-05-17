export type EconomicImpact = "low" | "medium" | "high"

export interface EconomicCalendarEvent {
  id: string
  datetime: string
  country: string
  currency: string
  event: string
  impact: EconomicImpact
  actual: number | null
  forecast: number | null
  previous: number | null
  unit: string
  change: number | null
}

function parseImpact(raw: unknown): EconomicImpact {
  const s = String(raw ?? "").trim().toLowerCase()
  if (s === "high" || s === "3" || s.includes("high")) return "high"
  if (s === "medium" || s === "2" || s.includes("med")) return "medium"
  return "low"
}

function parseNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function stableId(parts: string[]): string {
  let h = 0
  const s = parts.join("|")
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `ec-${Math.abs(h)}`
}

function buildDatetime(dateStr: string, timeStr: string): string {
  const date = dateStr.trim()
  const time = timeStr.trim() || "00:00:00"
  const iso = time.length <= 5 ? `${date}T${time}:00` : `${date}T${time}`
  const ms = Date.parse(iso)
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  const fallback = Date.parse(date)
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : new Date().toISOString()
}

export function normalizeFmpCalendarRow(raw: Record<string, unknown>): EconomicCalendarEvent | null {
  const event = String(raw.event ?? raw.name ?? raw.title ?? "").trim()
  if (!event) return null

  const date = String(raw.date ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const time = String(raw.time ?? raw.releaseTime ?? "00:00:00")
  const datetime = buildDatetime(date, time)
  const country = String(raw.country ?? "").trim().toUpperCase()
  const currency = String(raw.currency ?? raw.countryCode ?? country ?? "").trim().toUpperCase()
  const impact = parseImpact(raw.impact ?? raw.importance ?? raw.volatility)

  return {
    id: stableId([datetime, country, currency, event]),
    datetime,
    country,
    currency,
    event,
    impact,
    actual: parseNumber(raw.actual ?? raw.actualValue),
    forecast: parseNumber(raw.estimate ?? raw.forecast ?? raw.forecastValue),
    previous: parseNumber(raw.previous ?? raw.previousValue ?? raw.prev),
    unit: String(raw.unit ?? "").trim(),
    change: parseNumber(raw.change),
  }
}

export function normalizeFmpCalendarList(raw: unknown): EconomicCalendarEvent[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => (row && typeof row === "object" ? normalizeFmpCalendarRow(row as Record<string, unknown>) : null))
    .filter((e): e is EconomicCalendarEvent => e != null)
    .sort((a, b) => a.datetime.localeCompare(b.datetime))
}

export function filterCalendarEvents(
  events: EconomicCalendarEvent[],
  opts: { country?: string; impact?: string },
): EconomicCalendarEvent[] {
  let out = events
  const country = (opts.country ?? "").trim().toUpperCase()
  if (country && country !== "ALL") {
    out = out.filter((e) => e.country === country || e.currency === country)
  }
  const impact = (opts.impact ?? "").trim().toLowerCase()
  if (impact && impact !== "all") {
    out = out.filter((e) => e.impact === impact)
  }
  return out
}
