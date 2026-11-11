export function whatsappShadowChannelId(groupJid: string): string {
  return `wa:${groupJid}`
}

export function isWhatsAppGroupJid(groupJid: string): boolean {
  return /^\d+@g\.us$/.test(groupJid.trim())
}

export function whatsappListenerBaseUrl(): string {
  const raw = String(import.meta.env.VITE_WHATSAPP_LISTENER_URL ?? '').trim().replace(/\/$/, '')
  if (!raw) return ''
  // Netlify/Railway often paste the host without a scheme; browser fetch then
  // treats it as a relative path and the UI shows "listener is not running".
  if (/^https?:\/\//i.test(raw)) return raw
  return `https://${raw}`
}
