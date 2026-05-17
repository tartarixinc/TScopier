import { request } from 'undici'
import type { EconomicCalendarEvent, EconomicImpact } from './types'

const CACHE_TTL_MS = 15 * 60_000
let cache: { expires: number; events: EconomicCalendarEvent[] } | null = null
let warnedNoKey = false

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseImpact(raw: unknown): EconomicImpact {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'high' || s === '3' || s.includes('high')) return 'high'
  if (s === 'medium' || s === '2' || s.includes('med')) return 'medium'
  return 'low'
}

function buildDatetime(dateStr: string, timeStr: string): string {
  const date = dateStr.trim()
  const time = timeStr.trim() || '00:00:00'
  const iso = time.length <= 5 ? `${date}T${time}:00` : `${date}T${time}`
  const ms = Date.parse(iso)
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  const fallback = Date.parse(date)
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : new Date().toISOString()
}

function normalizeRow(raw: Record<string, unknown>): EconomicCalendarEvent | null {
  const event = String(raw.event ?? raw.name ?? raw.title ?? '').trim()
  if (!event) return null
  const date = String(raw.date ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const time = String(raw.time ?? raw.releaseTime ?? '00:00:00')
  const country = String(raw.country ?? '').trim().toUpperCase()
  const currency = String(raw.currency ?? raw.countryCode ?? country ?? '').trim().toUpperCase()
  const datetime = buildDatetime(date, time)
  const impact = parseImpact(raw.impact ?? raw.importance ?? raw.volatility)
  let h = 0
  const idKey = `${datetime}|${country}|${currency}|${event}`
  for (let i = 0; i < idKey.length; i++) h = ((h << 5) - h + idKey.charCodeAt(i)) | 0
  return {
    id: `ec-${Math.abs(h)}`,
    datetime,
    country,
    currency,
    event,
    impact,
  }
}

export async function getCalendarEventsCached(now = new Date()): Promise<EconomicCalendarEvent[]> {
  if (cache && cache.expires > Date.now()) return cache.events

  const apiKey = (process.env.FMP_API_KEY ?? '').trim()
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true
      console.warn('[newsTrading] FMP_API_KEY missing — news blackout filter cannot load calendar events')
    }
    return []
  }

  const fromDate = new Date(now)
  fromDate.setDate(fromDate.getDate() - 1)
  const toDate = new Date(now)
  toDate.setDate(toDate.getDate() + 2)

  const url = new URL('https://financialmodelingprep.com/stable/economic-calendar')
  url.searchParams.set('from', isoDate(fromDate))
  url.searchParams.set('to', isoDate(toDate))
  url.searchParams.set('apikey', apiKey)

  try {
    const { statusCode, body } = await request(url.toString(), { method: 'GET', maxRedirections: 2 })
    const text = await body.text()
    if (statusCode < 200 || statusCode >= 300) {
      console.warn(`[newsTrading] calendar fetch HTTP ${statusCode}`)
      return cache?.events ?? []
    }
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : []
    const events = list
      .map(row => normalizeRow(row as Record<string, unknown>))
      .filter((e): e is EconomicCalendarEvent => e != null)
    cache = { expires: Date.now() + CACHE_TTL_MS, events }
    return events
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[newsTrading] calendar fetch failed: ${msg}`)
    return cache?.events ?? []
  }
}

export function clearCalendarCacheForTests(): void {
  cache = null
  warnedNoKey = false
}
