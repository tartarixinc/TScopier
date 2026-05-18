/** Help menu destinations — override via Vite env at build time. */
export const HELP_LINKS = {
  documentation:
    (import.meta.env.VITE_HELP_DOCS_URL as string | undefined)?.trim() ||
    'https://docs.tscopier.com',
  liveChat: (import.meta.env.VITE_HELP_LIVE_CHAT_URL as string | undefined)?.trim() || '',
  whatsapp: (import.meta.env.VITE_HELP_WHATSAPP_URL as string | undefined)?.trim() || '',
  telegram: (import.meta.env.VITE_HELP_TELEGRAM_URL as string | undefined)?.trim() || '',
  status:
    (import.meta.env.VITE_HELP_STATUS_URL as string | undefined)?.trim() ||
    'https://status.tscopier.com',
} as const

export type HelpLinkKey = keyof typeof HELP_LINKS

export function isExternalHelpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
