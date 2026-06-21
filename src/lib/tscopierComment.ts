/** MT order comment parsing (no Supabase — safe for unit tests). */

export interface ParsedTscopierComment {
  channelSlug: string | null
  signalIdPrefix: string
}

export const TSCOPIER_COMMENT_PREFIX = 'TScopier:'
/** Legacy MT comments written before brand casing was standardized. */
export const LEGACY_TSCOPIER_COMMENT_PREFIX = 'TSCopier:'

/** Max length of the channel slug segment in MT order comments (matches worker tradeComment). */
export const CHANNEL_COMMENT_SLUG_MAX = 12

/** True when comment uses the current or legacy TScopier order prefix. */
export function isTscopierComment(comment: string | null | undefined): boolean {
  if (!comment?.trim()) return false
  const trimmed = comment.trim()
  return (
    trimmed.startsWith(TSCOPIER_COMMENT_PREFIX)
    || trimmed.startsWith(LEGACY_TSCOPIER_COMMENT_PREFIX)
  )
}

function stripTscopierCommentPrefix(trimmed: string): string | null {
  if (trimmed.startsWith(TSCOPIER_COMMENT_PREFIX)) {
    return trimmed.slice(TSCOPIER_COMMENT_PREFIX.length)
  }
  if (trimmed.startsWith(LEGACY_TSCOPIER_COMMENT_PREFIX)) {
    return trimmed.slice(LEGACY_TSCOPIER_COMMENT_PREFIX.length)
  }
  return null
}

/** Strip to broker-safe alphanumeric slug used in TScopier order comments. */
export function sanitizeChannelCommentSlug(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, '')
  if (!trimmed) return ''
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length >= 2) return alnum.slice(0, CHANNEL_COMMENT_SLUG_MAX)
  const collapsed = trimmed.replace(/[^a-zA-Z0-9]+/g, '')
  return collapsed.slice(0, CHANNEL_COMMENT_SLUG_MAX) || 'ch'
}

/** True when a full signal UUID starts with the 8-char hex prefix from MT comments. */
export function signalIdMatchesPrefix(signalId: string, prefix: string): boolean {
  const norm = prefix.toLowerCase()
  if (norm.length !== 8 || !/^[a-f0-9]+$/.test(norm)) return false
  return signalId.toLowerCase().startsWith(norm)
}

/** Parse `TScopier:ChannelSlug:abc12345` or `TScopier:abc12345` from MT order comment. */
export function parseTscopierComment(comment: string | null | undefined): ParsedTscopierComment | null {
  if (!comment?.trim()) return null
  const trimmed = comment.trim()
  const body = stripTscopierCommentPrefix(trimmed)
  if (body === null) return null

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
