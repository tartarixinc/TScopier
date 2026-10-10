export type WhatsAppMessageContent = {
  conversation?: string | null
  extendedTextMessage?: { text?: string | null } | null
  imageMessage?: { caption?: string | null } | null
  videoMessage?: { caption?: string | null } | null
  documentMessage?: { caption?: string | null } | null
  ephemeralMessage?: { message?: WhatsAppMessageContent | null } | null
  viewOnceMessage?: { message?: WhatsAppMessageContent | null } | null
  viewOnceMessageV2?: { message?: WhatsAppMessageContent | null } | null
}

/** Text, extended text, or a media caption. Empty when the post has nothing to parse. */
export function whatsappMessageText(message: WhatsAppMessageContent | null | undefined): string {
  if (!message) return ''
  const inner = message.ephemeralMessage?.message
    ?? message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message
  const text = inner.conversation
    || inner.extendedTextMessage?.text
    || inner.imageMessage?.caption
    || inner.videoMessage?.caption
    || inner.documentMessage?.caption
    || ''
  return text.trim().slice(0, 8000)
}

export function isWhatsAppGroupJid(jid: string | null | undefined): jid is string {
  return typeof jid === 'string' && /^\d+@g\.us$/.test(jid)
}
