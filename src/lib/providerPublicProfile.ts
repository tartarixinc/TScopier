import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSocialProfileLinks, type SocialProfileLinks } from './socialProfileLinks'

export type ProviderPublicProfile = {
  profileUserId: string
  slug: string
  displayName: string
  username: string
  country: string
  bio: string | null
  access: 'open' | 'private'
  followerCount: number
  averageRating: number | null
  reviewCount: number
  monthlyCopyPriceCents: number | null
  socialLinks: SocialProfileLinks
  accountKind: 'demo' | 'live' | 'prop' | 'unknown'
  platform: string | null
  balance: number | null
  equity: number | null
  currency: string | null
  snapshotAt: string | null
  joinedAt: string | null
}

type Row = {
  profile_user_id: string
  slug: string
  display_name: string
  username: string
  country: string
  bio: string | null
  access_mode: 'open' | 'private'
  follower_count: number | string
  average_rating: number | string | null
  review_count: number | string
  monthly_copy_price_cents: number | string | null
  social_links: unknown
  account_kind: string | null
  platform: string | null
  balance: number | string | null
  equity: number | string | null
  currency: string | null
  snapshot_at: string | null
  joined_at: string | null
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export function isValidProviderSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

const num = (value: number | string | null): number | null => value == null ? null : Number(value)

export function mapProviderPublicProfile(row: Row): ProviderPublicProfile {
  const kind = row.account_kind
  return {
    profileUserId: row.profile_user_id,
    slug: row.slug,
    displayName: row.display_name,
    username: row.username,
    country: row.country,
    bio: row.bio,
    access: row.access_mode,
    followerCount: Number(row.follower_count),
    averageRating: num(row.average_rating),
    reviewCount: Number(row.review_count),
    monthlyCopyPriceCents: num(row.monthly_copy_price_cents),
    socialLinks: normalizeSocialProfileLinks(row.social_links),
    accountKind: kind === 'demo' || kind === 'live' || kind === 'prop' ? kind : 'unknown',
    platform: row.platform,
    balance: num(row.balance),
    equity: num(row.equity),
    currency: row.currency,
    snapshotAt: row.snapshot_at,
    joinedAt: row.joined_at,
  }
}

/** Returns null when the slug is unknown, unlisted or not an approved provider. */
export async function fetchProviderPublicProfile(client: SupabaseClient, slug: string): Promise<ProviderPublicProfile | null> {
  const normalized = slug.trim().toLowerCase()
  if (!isValidProviderSlug(normalized)) return null
  const { data, error } = await client.rpc('get_provider_public_profile', { p_slug: normalized })
  if (error) throw new Error(error.message || 'Unable to load this provider.')
  const row = ((data ?? []) as Row[])[0]
  return row ? mapProviderPublicProfile(row) : null
}
