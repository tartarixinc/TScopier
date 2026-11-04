export function whatsappShadowChannelId(groupJid: string): string {
  return `wa:${groupJid}`
}

export function isWhatsAppGroupJid(groupJid: string): boolean {
  return /^\d+@g\.us$/.test(groupJid.trim())
}

export function whatsappListenerBaseUrl(): string {
  return String(import.meta.env.VITE_WHATSAPP_LISTENER_URL ?? '').trim().replace(/\/$/, '')
}
