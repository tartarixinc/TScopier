import { useId, type ReactNode } from 'react'
import {
  SOCIAL_PROFILE_PLATFORMS,
  safeExternalSocialUrl,
  type SocialProfilePlatform,
} from '../../lib/socialProfileLinks'

function BrandSvg({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`h-4 w-4 ${className}`} aria-hidden="true" focusable="false">{children}</svg>
}

export function SocialBrandIcon({ platform }: { platform: SocialProfilePlatform }) {
  const gradientId = `instagram-${useId().replace(/:/g, '')}`

  if (platform === 'x') return <BrandSvg className="fill-black dark:fill-white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.967 6.817H1.68l7.736-8.84L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></BrandSvg>
  if (platform === 'instagram') return (
    <BrandSvg>
      <defs><linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse"><stop stopColor="#FFDC80" /><stop offset="0.32" stopColor="#F77737" /><stop offset="0.62" stopColor="#E1306C" /><stop offset="1" stopColor="#833AB4" /></linearGradient></defs>
      <rect x="2" y="2" width="20" height="20" rx="5.5" fill={`url(#${gradientId})`} />
      <circle cx="12" cy="12" r="4.3" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="17.45" cy="6.65" r="1.15" fill="#fff" />
    </BrandSvg>
  )
  if (platform === 'linkedin') return (
    <BrandSvg><rect x="2" y="2" width="20" height="20" rx="2.5" fill="#0A66C2" /><circle cx="7.1" cy="8" r="1.35" fill="#fff" /><path fill="#fff" d="M5.9 10.1h2.4v7.7H5.9v-7.7Zm3.9 0h2.3v1.05h.03c.33-.62 1.12-1.28 2.3-1.28 2.46 0 2.92 1.62 2.92 3.73v4.2h-2.4v-3.72c0-.89-.02-2.03-1.24-2.03-1.24 0-1.43.97-1.43 1.96v3.79H9.8v-7.7Z" /></BrandSvg>
  )
  if (platform === 'youtube') return (
    <BrandSvg><path fill="#FF0000" d="M22.3 7.1a2.7 2.7 0 0 0-1.9-1.92C18.72 4.72 12 4.72 12 4.72s-6.72 0-8.4.46A2.7 2.7 0 0 0 1.7 7.1 28.2 28.2 0 0 0 1.25 12c0 1.65.15 3.29.45 4.9a2.7 2.7 0 0 0 1.9 1.92c1.68.46 8.4.46 8.4.46s6.72 0 8.4-.46a2.7 2.7 0 0 0 1.9-1.92c.3-1.61.45-3.25.45-4.9s-.15-3.29-.45-4.9Z" /><path fill="#fff" d="m9.8 15.15 5.75-3.15L9.8 8.85v6.3Z" /></BrandSvg>
  )
  if (platform === 'tiktok') return (
    <BrandSvg><path fill="#25F4EE" d="M15.35 3.25h2.72a4.64 4.64 0 0 0 2.68 2.62v2.78a7.2 7.2 0 0 1-3.37-1.03v6.48a5.46 5.46 0 1 1-4.7-5.41v2.76a2.72 2.72 0 1 0 1.95 2.61V3.25h.72Z" transform="translate(-.75 .45)" /><path fill="#FE2C55" d="M15.35 3.25h2.72a4.64 4.64 0 0 0 2.68 2.62v2.78a7.2 7.2 0 0 1-3.37-1.03v6.48a5.46 5.46 0 1 1-4.7-5.41v2.76a2.72 2.72 0 1 0 1.95 2.61V3.25h.72Z" transform="translate(.65 -.3)" /><path fill="#111111" d="M15.35 3.25h2.72a4.64 4.64 0 0 0 2.68 2.62v2.78a7.2 7.2 0 0 1-3.37-1.03v6.48a5.46 5.46 0 1 1-4.7-5.41v2.76a2.72 2.72 0 1 0 1.95 2.61V3.25h.72Z" /></BrandSvg>
  )
  return <BrandSvg><circle cx="12" cy="12" r="10" fill="#1877F2" /><path fill="#fff" d="M13.55 21v-8h2.68l.4-3.12h-3.08V7.9c0-.9.25-1.52 1.55-1.52h1.66V3.6a22.2 22.2 0 0 0-2.42-.13c-2.4 0-4.04 1.46-4.04 4.15v2.26H7.6V13h2.7v8h3.25Z" /></BrandSvg>
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
        <a key={platform.key} href={platform.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Open ${platform.label} profile`} title={platform.label} className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-neutral-200 bg-white px-1.5 transition-colors hover:border-green-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 dark:border-neutral-700 dark:bg-neutral-900">
          <SocialBrandIcon platform={platform.key} />
        </a>
      ))}
    </nav>
  )
}
