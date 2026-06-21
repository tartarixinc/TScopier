import { supabase } from './supabase'

/** Row key in `app_settings` for the global announcement bar. */
export const APP_ANNOUNCEMENT_SETTING_KEY = 'announcement_message'

export const DEFAULT_APP_ANNOUNCEMENT_LINK_LABEL = 'Click here'

export type AppAnnouncementState = {
  enabled: boolean
  message: string | null
  linkHref: string | null
  linkLabel: string | null
}

export const APP_ANNOUNCEMENT_DISABLED: AppAnnouncementState = {
  enabled: false,
  message: null,
  linkHref: null,
  linkLabel: null,
}

export function resolveAppAnnouncementMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveAppAnnouncementLinkHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveAppAnnouncementLinkLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function isExternalAnnouncementHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith('//')
}

export function normalizeAppAnnouncementRow(row: {
  enabled?: boolean | null
  message?: string | null
  link_href?: string | null
  link_label?: string | null
} | null | undefined): AppAnnouncementState {
  if (!row?.enabled) return APP_ANNOUNCEMENT_DISABLED
  const message = resolveAppAnnouncementMessage(row.message)
  if (!message) return APP_ANNOUNCEMENT_DISABLED
  const linkHref = resolveAppAnnouncementLinkHref(row.link_href)
  const linkLabel = linkHref
    ? (resolveAppAnnouncementLinkLabel(row.link_label) ?? DEFAULT_APP_ANNOUNCEMENT_LINK_LABEL)
    : null
  return { enabled: true, message, linkHref, linkLabel }
}

/** Load announcement flag, message, and optional link from Supabase. */
export async function fetchAppAnnouncementState(): Promise<AppAnnouncementState> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('enabled,message,link_href,link_label')
    .eq('key', APP_ANNOUNCEMENT_SETTING_KEY)
    .maybeSingle()

  if (error) {
    console.warn('[appAnnouncement] load failed', error.message)
    return APP_ANNOUNCEMENT_DISABLED
  }

  return normalizeAppAnnouncementRow(data)
}
