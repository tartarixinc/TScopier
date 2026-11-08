import { supabase } from './supabase'
import { isExternalAnnouncementHref } from './appAnnouncement'

/** The promo banner shown above the marketing nav (table `marketing_promo_banner`). */
export type MarketingPromo = {
  id: string
  headline: string | null
  couponCode: string | null
  ctaLabel: string | null
  ctaHref: string | null
  mediaUrl: string | null
  mediaUrlMobile: string | null
  /** Epoch ms. */
  startsAt: number | null
  /** Epoch ms. Drives the countdown; the banner is hidden from this moment. */
  endsAt: number | null
  dismissible: boolean
}

export type MarketingPromoRow = {
  id?: string | null
  enabled?: boolean | null
  headline?: string | null
  coupon_code?: string | null
  cta_label?: string | null
  cta_href?: string | null
  media_url?: string | null
  media_url_mobile?: string | null
  starts_at?: string | null
  ends_at?: string | null
  dismissible?: boolean | null
}

export const DEFAULT_PROMO_CTA_LABEL = 'Get offer'

export type PromoMediaKind = 'video' | 'image'

function trimmed(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length > 0 ? value : null
}

function toMs(raw: unknown): number | null {
  const text = trimmed(raw)
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** A site path (`/pricing`) or an absolute https URL. Anything else (javascript:, //host, http:) is dropped. */
export function sanitizePromoHref(raw: unknown): string | null {
  const href = trimmed(raw)
  if (!href) return null
  if (/^\/(?![/\\])/.test(href)) return href
  if (/^https:\/\/[^\s]+$/i.test(href)) return href
  return null
}

/** Media may be a site path or an https URL. */
export function sanitizePromoMediaUrl(raw: unknown): string | null {
  const url = trimmed(raw)
  if (!url) return null
  if (/^\/(?![/\\])/.test(url)) return url
  if (/^https:\/\/[^\s]+$/i.test(url)) return url
  return null
}

/** Video for mp4, webm and mov. Everything else, GIFs included, is an image. */
export function promoMediaKind(url: string): PromoMediaKind {
  const path = url.split(/[?#]/)[0] ?? ''
  return /\.(mp4|webm|mov|m4v)$/i.test(path) ? 'video' : 'image'
}

export function isExternalPromoHref(href: string): boolean {
  return isExternalAnnouncementHref(href)
}

/** Null when the row is disabled, outside its window, or has nothing to show. */
export function normalizeMarketingPromoRow(
  row: MarketingPromoRow | null | undefined,
  now: number = Date.now(),
): MarketingPromo | null {
  if (!row?.enabled) return null
  const startsAt = toMs(row.starts_at)
  const endsAt = toMs(row.ends_at)
  if (startsAt != null && startsAt > now) return null
  if (endsAt != null && endsAt <= now) return null

  const headline = trimmed(row.headline)
  const couponCode = trimmed(row.coupon_code)
  const ctaHref = sanitizePromoHref(row.cta_href)
  const mediaUrl = sanitizePromoMediaUrl(row.media_url)
  if (!headline && !couponCode && !ctaHref && !mediaUrl) return null

  return {
    id: trimmed(row.id) ?? 'promo',
    headline,
    couponCode,
    ctaLabel: ctaHref ? (trimmed(row.cta_label) ?? DEFAULT_PROMO_CTA_LABEL) : null,
    ctaHref,
    mediaUrl,
    mediaUrlMobile: sanitizePromoMediaUrl(row.media_url_mobile),
    startsAt,
    endsAt,
    dismissible: row.dismissible !== false,
  }
}

export type CountdownParts = {
  days: number
  hours: number
  minutes: number
  seconds: number
  /** True once `endsAt` has passed. */
  done: boolean
}

export function countdownParts(endsAt: number, now: number): CountdownParts {
  const total = Math.max(0, Math.floor((endsAt - now) / 1000))
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    done: total === 0,
  }
}

/** Identity of the current campaign. A change means a new campaign, so a prior dismissal no longer applies. */
export function promoRevision(promo: Pick<MarketingPromo, 'id' | 'headline' | 'couponCode' | 'ctaHref' | 'endsAt'>): string {
  return [promo.id, promo.headline ?? '', promo.couponCode ?? '', promo.ctaHref ?? '', promo.endsAt ?? ''].join('\0')
}

/** The live campaign, if any. The newest enabled row wins; failures never break the page. */
export async function fetchMarketingPromo(): Promise<MarketingPromo | null> {
  const { data, error } = await supabase
    .from('marketing_promo_banner')
    .select('id,enabled,headline,coupon_code,cta_label,cta_href,media_url,media_url_mobile,starts_at,ends_at,dismissible')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[marketingPromo] load failed', error.message)
    return null
  }
  return normalizeMarketingPromoRow(data)
}
