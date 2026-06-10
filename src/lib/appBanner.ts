import { supabase } from './supabase'

/** Row key in `app_settings` for the global information banner. */
export const APP_BANNER_SETTING_KEY = 'banner_message'

/** Default copy when the DB row has no message (also used to seed migrations). */
export const DEFAULT_APP_BANNER_MESSAGE =
  'Maintenance Notice: The Worker is currently undergoing maintenance, signal copying might be unstable, please apply caution'

export type AppBannerState = {
  enabled: boolean
  message: string | null
}

export const APP_BANNER_DISABLED: AppBannerState = { enabled: false, message: null }

export function resolveAppBannerMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeAppBannerRow(row: {
  enabled?: boolean | null
  message?: string | null
} | null | undefined): AppBannerState {
  if (!row?.enabled) return APP_BANNER_DISABLED
  const message = resolveAppBannerMessage(row.message) ?? DEFAULT_APP_BANNER_MESSAGE
  return { enabled: true, message }
}

/** Load banner flag + message from Supabase (single source for UI and context). */
export async function fetchAppBannerState(): Promise<AppBannerState> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('enabled,message')
    .eq('key', APP_BANNER_SETTING_KEY)
    .maybeSingle()

  if (error) {
    console.warn('[appBanner] load failed', error.message)
    return APP_BANNER_DISABLED
  }

  return normalizeAppBannerRow(data)
}
