/** MT order comment parsing (no Supabase — safe for unit tests). */

export interface ParsedTscopierComment {
  channelSlug: string | null
  signalIdPrefix: string
}

const TSCOPIER_PREFIX = 'TSCopier:'

/** Max length of the channel slug segment in MT order comments (matches worker tradeComment). */
export const CHANNEL_COMMENT_SLUG_MAX = 12

/** Strip to broker-safe alphanumeric slug used in TSCopier order comments. */
export function sanitizeChannelCommentSlug(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '')
  if (!trimmed) return ''
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length >= 2) return alnum.slice(0, CHANNEL_COMMENT_SLUG_MAX)
  const collapsed = trimmed.replace(/[^a-zA-Z0-9]+/g, '')
  return collapsed.slice(0, CHANNEL_COMMENT_SLUG_MAX) || 'ch'
}

/** Parse `TSCopier:ChannelSlug:abc12345` or `TSCopier:abc12345` from MT order comment. */
export function parseTscopierComment(comment: string | null | undefined): ParsedTscopierComment | null {
  if (!comment?.trim()) return null
  const trimmed = comment.trim()
  if (!trimmed.startsWith(TSCOPIER_PREFIX)) return null

  const body = trimmed.slice(TSCOPIER_PREFIX.length)
  const segments = body.split(':').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return null

  const id8From = (s: string): string | null => {
    const m = s.match(/^([a-f0-9]{8})/i)
    return m ? m[1]!.toLowerCase() : null
  }

  if (segments.length === 1) {
    const prefix = id8From(segments[0]!)
    return prefix ? { channelSlug: null, signalIdPrefix: prefix } : null
  }

  const firstPrefix = id8From(segments[0]!)
  if (firstPrefix) {
    return { channelSlug: null, signalIdPrefix: firstPrefix }
  }

  const secondPrefix = id8From(segments[1] ?? '')
  if (secondPrefix) {
    return { channelSlug: segments[0]!, signalIdPrefix: secondPrefix }
  }

  return null
}
