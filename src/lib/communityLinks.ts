/** Public community destinations. Values are baked in during the Vite build. */
export const TELEGRAM_COMMUNITY_URL = (import.meta.env.VITE_TELEGRAM_COMMUNITY_URL as string | undefined)?.trim() || ''
