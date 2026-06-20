/**
 * MT order comment helpers. All copier trades use a `TScopier:` prefix so open-
 * order reconciliation can find our legs; when a signal has a channel we embed
 * a short channel slug before the signal id.
 */

/** Max length of the channel slug segment (broker-safe alphanumeric). */
export const CHANNEL_COMMENT_SLUG_MAX = 12

/** Resolve the human label used for the comment slug. */
export function resolveChannelLabelForComment(
  displayName?: string | null,
  channelUsername?: string | null,
): string {
  const dn = displayName?.trim()
  if (dn) return dn
  return channelUsername?.trim().replace(/^@/, '') ?? ''
}

/**
 * Strip to characters MT terminals accept in comments (letters and digits only).
 */
export function sanitizeChannelCommentSlug(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '')
  if (!trimmed) return ''
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length >= 2) return alnum.slice(0, CHANNEL_COMMENT_SLUG_MAX)
  const collapsed = trimmed.replace(/[^a-zA-Z0-9]+/g, '')
  return collapsed.slice(0, CHANNEL_COMMENT_SLUG_MAX) || 'ch'
}

/**
 * Prefix for planner / OrderSend comments.
 * With channel: `TScopier:ChannelSlug:abc12345`
 * Without: `TScopier:abc12345`
 */
export function buildTscopierCommentPrefix(signalId: string, channelSlug?: string | null): string {
  const id8 = signalId.slice(0, 8)
  const slug = channelSlug?.trim()
  if (slug) return `TScopier:${slug}:${id8}`
  return `TScopier:${id8}`
}

export type OrderCommentsManual = { order_comments_enabled?: boolean } | null | undefined

/** Default on — only explicit `false` disables MT order comments. */
export function areOrderCommentsEnabled(manual?: OrderCommentsManual): boolean {
  return manual?.order_comments_enabled !== false
}

/**
 * Resolve the comment prefix for a broker after manual settings are known.
 * Returns empty string when order comments are disabled for that channel config.
 */
export function resolveTscopierCommentPrefix(
  signalId: string,
  channelSlug?: string | null,
  manual?: OrderCommentsManual,
  overridePrefix?: string | null,
): string {
  if (!areOrderCommentsEnabled(manual)) return ''
  if (overridePrefix != null && overridePrefix !== '') return overridePrefix
  return buildTscopierCommentPrefix(signalId, channelSlug)
}

/** Append a planner suffix (`:tp1`, `:rg2.tp`, …); empty when comments are off. */
export function appendOrderCommentSuffix(prefix: string, suffix: string): string {
  if (!prefix) return ''
  return `${prefix}${suffix}`
}

/** Comment for basket refresh OrderSend when a leg must be re-opened. */
export function buildBasketRefreshComment(signalId: string, manual?: OrderCommentsManual): string {
  if (!areOrderCommentsEnabled(manual)) return ''
  return `TScopier:${signalId.slice(0, 8)}:refresh`
}
