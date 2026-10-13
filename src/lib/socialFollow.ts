import type { SupabaseClient } from '@supabase/supabase-js'

export type SocialFollowStatus = 'pending' | 'accepted' | 'declined'
export type SocialProfileAccess = 'open' | 'private'
export type SocialFollowErrorKind =
  | 'verification_required'
  | 'profile_required'
  | 'profile_incomplete'
  | 'profile_unavailable'
  | 'not_authorized'
  | 'invalid_request'
  | 'conflict'
  | 'backend_unavailable'
  | 'unknown'

export type SocialFollowOperation =
  | 'directory'
  | 'register'
  | 'access'
  | 'follow'
  | 'remove'
  | 'resolve'
  | 'mutation'

export interface SocialDirectoryProfile {
  profileUserId: string
  displayName: string
  username: string
  country: string
  access: SocialProfileAccess
  isSelf: boolean
  followerCount: number
  followingCount: number
  viewerRelationshipStatus: SocialFollowStatus | null
  followsViewerStatus: SocialFollowStatus | null
}

interface SocialDirectoryRow {
  profile_user_id: string
  display_name: string
  username: string
  country: string
  access_mode: SocialProfileAccess
  is_self: boolean
  follower_count: number | string
  following_count: number | string
  viewer_relationship_status: SocialFollowStatus | null
  follows_viewer_status: SocialFollowStatus | null
}

interface RpcErrorLike {
  code?: string
  message?: string
  details?: string
  hint?: string
}

export class SocialFollowError extends Error {
  readonly kind: SocialFollowErrorKind
  readonly operation: SocialFollowOperation
  readonly databaseCode: string | null

  constructor(
    kind: SocialFollowErrorKind,
    operation: SocialFollowOperation,
    databaseCode: string | null,
    cause?: unknown,
  ) {
    super(`Social Follow ${operation} failed`, { cause })
    this.name = 'SocialFollowError'
    this.kind = kind
    this.operation = operation
    this.databaseCode = databaseCode
  }
}

function includes(message: string, value: string): boolean {
  return message.toLowerCase().includes(value.toLowerCase())
}

export function socialFollowErrorFrom(
  cause: unknown,
  operation: SocialFollowOperation,
): SocialFollowError {
  if (cause instanceof SocialFollowError) return cause

  const rpc = cause && typeof cause === 'object' ? cause as RpcErrorLike : {}
  const code = typeof rpc.code === 'string' ? rpc.code : null
  const message = typeof rpc.message === 'string' ? rpc.message : ''
  let kind: SocialFollowErrorKind = 'unknown'

  if (includes(message, 'verified account')) kind = 'verification_required'
  else if (includes(message, 'registered, listed social profile')) kind = 'profile_required'
  else if (includes(message, 'complete your display name or username') || includes(message, 'listed social profile requires')) kind = 'profile_incomplete'
  else if (includes(message, 'social profile is not available')) kind = 'profile_unavailable'
  else if (code === '42501') kind = 'not_authorized'
  else if (code === '23505' || code === 'P0002') kind = 'conflict'
  else if (code === '22004' || code === '22023' || code === '23514') kind = 'invalid_request'
  else if (code?.startsWith('PGRST') || code === '08000' || code === '08001' || code === '08006' || includes(message, 'failed to fetch') || includes(message, 'network')) {
    kind = 'backend_unavailable'
  }

  return new SocialFollowError(kind, operation, code, cause)
}

function throwRpcError(error: unknown, operation: SocialFollowOperation): never {
  throw socialFollowErrorFrom(error, operation)
}

function count(value: number | string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function mapProfile(row: SocialDirectoryRow): SocialDirectoryProfile {
  return {
    profileUserId: row.profile_user_id,
    displayName: row.display_name,
    username: row.username,
    country: row.country,
    access: row.access_mode,
    isSelf: row.is_self,
    followerCount: count(row.follower_count),
    followingCount: count(row.following_count),
    viewerRelationshipStatus: row.viewer_relationship_status,
    followsViewerStatus: row.follows_viewer_status,
  }
}

export async function fetchSocialDirectory(
  client: SupabaseClient,
): Promise<SocialDirectoryProfile[]> {
  const { data, error } = await client.rpc('get_social_directory')
  if (error) throwRpcError(error, 'directory')
  return ((data ?? []) as SocialDirectoryRow[]).map(mapProfile)
}

export async function registerSocialProfile(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc('register_social_profile')
  if (error) throwRpcError(error, 'register')
}

export async function setSocialProfileAccess(
  client: SupabaseClient,
  access: SocialProfileAccess,
): Promise<void> {
  const { error } = await client.rpc('set_social_profile_access', { p_access_mode: access })
  if (error) throwRpcError(error, 'access')
}

export async function followSocialProfile(
  client: SupabaseClient,
  profileUserId: string,
): Promise<SocialFollowStatus> {
  const { data, error } = await client.rpc('follow_social_profile', {
    p_profile_user_id: profileUserId,
  })
  if (error) throwRpcError(error, 'follow')
  if (data !== 'pending' && data !== 'accepted' && data !== 'declined') {
    throw new SocialFollowError('unknown', 'follow', null)
  }
  return data
}

export async function removeSocialFollow(
  client: SupabaseClient,
  profileUserId: string,
): Promise<void> {
  const { error } = await client.rpc('remove_social_follow', {
    p_profile_user_id: profileUserId,
  })
  if (error) throwRpcError(error, 'remove')
}

export async function resolveSocialFollowRequest(
  client: SupabaseClient,
  followerUserId: string,
  decision: 'accepted' | 'declined',
): Promise<void> {
  const { error } = await client.rpc('resolve_social_follow_request', {
    p_follower_user_id: followerUserId,
    p_decision: decision,
  })
  if (error) throwRpcError(error, 'resolve')
}

/**
 * The UI reports success only after the RPC and an authoritative refetch both
 * complete. Failed mutations also refetch so an uncertain network response
 * cannot leave optimistic state behind.
 */
export async function runSocialMutation(
  mutate: () => Promise<void>,
  refresh: () => Promise<void>,
): Promise<void> {
  try {
    await mutate()
  } catch (error) {
    try {
      await refresh()
    } catch {
      // Preserve the mutation error; the caller already has the prior snapshot.
    }
    throw error
  }
  await refresh()
}
