import { SOCIAL_PROFILE_PLATFORMS, safeExternalSocialUrl } from '../../lib/socialProfileLinks'

const MARKS: Record<string, string> = {
  x: 'X',
  instagram: '◎',
  linkedin: 'in',
  youtube: '▶',
  tiktok: '♪',
  facebook: 'f',
}

export function SocialProfileLinks({ links }: { links: Record<string, string> }) {
  const visible = SOCIAL_PROFILE_PLATFORMS.flatMap(platform => {
    const href = safeExternalSocialUrl(platform.key, links[platform.key] ?? '')
    return href ? [{ ...platform, href }] : []
  })
  if (!visible.length) return null
  return (
    <nav className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Public social profiles">
      {visible.map(platform => (
        <a
          key={platform.key}
          href={platform.href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`Open ${platform.label} profile`}
          title={platform.label}
          className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-neutral-200 bg-white px-1.5 text-[11px] font-bold text-neutral-800 transition-colors hover:border-green-400 hover:text-green-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <span aria-hidden="true">{MARKS[platform.key]}</span>
        </a>
      ))}
    </nav>
  )
}
