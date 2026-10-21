export const SOCIAL_PROFILE_PLATFORMS = [
  { key: 'x', label: 'X', placeholder: 'https://x.com/username', hosts: ['x.com', 'twitter.com'] },
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/username', hosts: ['instagram.com'] },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/in/username', hosts: ['linkedin.com'] },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@channel', hosts: ['youtube.com', 'youtu.be'] },
  { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@username', hosts: ['tiktok.com'] },
  { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/username', hosts: ['facebook.com'] },
] as const

export type SocialProfilePlatform = typeof SOCIAL_PROFILE_PLATFORMS[number]['key']
export type SocialProfileLinks = Partial<Record<SocialProfilePlatform, string>>

function hostMatches(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  return allowed.some(candidate => host === candidate || host.endsWith(`.${candidate}`))
}

export function normalizeSocialProfileLinks(input: unknown): SocialProfileLinks {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const value = input as Record<string, unknown>
  const links: SocialProfileLinks = {}
  for (const platform of SOCIAL_PROFILE_PLATFORMS) {
    const candidate = value[platform.key]
    const url = typeof candidate === 'string' ? candidate.trim() : ''
    if (url) links[platform.key] = url
  }
  return links
}

export function validateSocialProfileLinks(input: unknown): string | null {
  const links = normalizeSocialProfileLinks(input)
  for (const platform of SOCIAL_PROFILE_PLATFORMS) {
    const raw = links[platform.key]
    if (!raw) continue
    if (raw.length > 500) return `${platform.label} URL is too long.`
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return `Enter a valid ${platform.label} profile URL.`
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      return `${platform.label} must use a safe HTTPS profile URL.`
    }
    if (!hostMatches(url.hostname, platform.hosts) || url.pathname === '/') {
      return `Enter a ${platform.label} profile URL on ${platform.hosts[0]}.`
    }
  }
  return null
}

export function safeExternalSocialUrl(platform: SocialProfilePlatform, raw: string): string | null {
  const links = normalizeSocialProfileLinks({ [platform]: raw })
  return validateSocialProfileLinks(links) ? null : links[platform] ?? null
}
