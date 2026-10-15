import { supabase } from './supabase'

/** The announcement tag shown in the marketing hero (table `landing_announcements`). */
export type LandingAnnouncement = {
  id: string
  message: string
  linkHref: string | null
  linkLabel: string | null
}

type LandingAnnouncementRow = {
  id?: string | null
  message?: string | null
  translations?: unknown
  link_href?: string | null
  link_label?: string | null
}

function trimmed(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length > 0 ? value : null
}

/** Visitor-locale text if the row has a translation for it, otherwise the default message. */
export function normalizeLandingAnnouncementRow(
  row: LandingAnnouncementRow | null | undefined,
  locale: string,
): LandingAnnouncement | null {
  if (!row) return null
  const translations =
    row.translations && typeof row.translations === 'object' && !Array.isArray(row.translations)
      ? (row.translations as Record<string, unknown>)
      : {}
  const message = trimmed(translations[locale]) ?? trimmed(row.message)
  if (!message) return null
  const linkHref = trimmed(row.link_href)
  return {
    id: String(row.id ?? ''),
    message,
    linkHref,
    linkLabel: linkHref ? trimmed(row.link_label) : null,
  }
}

/** Newest live announcement (RLS already hides inactive or out-of-window rows), or null. */
export async function fetchLandingAnnouncementRow(): Promise<LandingAnnouncementRow | null> {
  const { data, error } = await supabase
    .from('landing_announcements')
    .select('id,message,translations,link_href,link_label')
    .order('starts_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[landingAnnouncement] load failed', error.message)
    return null
  }
  return data
}
