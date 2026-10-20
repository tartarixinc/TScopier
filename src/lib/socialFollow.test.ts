import { describe, expect, it, vi } from 'vitest'
import {
  fetchSocialDirectory,
  followSocialProfile,
  removeSocialFollow,
  resolveSocialFollowRequest,
  runSocialMutation,
  socialFollowErrorFrom,
} from './socialFollow'

function clientWithRpc(result: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null, ...result })
  return { client: { rpc } as never, rpc }
}

describe('socialFollow client', () => {
  it('maps authoritative directory rows and numeric aggregate counts', async () => {
    const { client } = clientWithRpc({
      data: [{
        profile_user_id: '00000000-0000-0000-0000-000000000001',
        display_name: 'Amina',
        username: 'amina',
        country: 'Nigeria',
        access_mode: 'private',
        is_self: false,
        follower_count: '3',
        following_count: 2,
        viewer_relationship_status: 'pending',
        follows_viewer_status: null,
      }],
    })

    await expect(fetchSocialDirectory(client)).resolves.toEqual([expect.objectContaining({
      displayName: 'Amina',
      followerCount: 3,
      followingCount: 2,
      viewerRelationshipStatus: 'pending',
    })])
  })

  it('never sends a caller-controlled follower identity', async () => {
    const { client, rpc } = clientWithRpc({ data: 'accepted' })
    await followSocialProfile(client, '00000000-0000-0000-0000-000000000002')
    expect(rpc).toHaveBeenCalledWith('follow_social_profile', {
      p_profile_user_id: '00000000-0000-0000-0000-000000000002',
    })
  })

  it('uses separate recipient-authorized resolution and requester-owned removal RPCs', async () => {
    const { client, rpc } = clientWithRpc({})
    await resolveSocialFollowRequest(client, '00000000-0000-0000-0000-000000000003', 'declined')
    await removeSocialFollow(client, '00000000-0000-0000-0000-000000000004')
    expect(rpc).toHaveBeenNthCalledWith(1, 'resolve_social_follow_request', {
      p_follower_user_id: '00000000-0000-0000-0000-000000000003',
      p_decision: 'declined',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'remove_social_follow', {
      p_profile_user_id: '00000000-0000-0000-0000-000000000004',
    })
  })
})

describe('socialFollowErrorFrom', () => {
  it('captures safe diagnostics for a missing directory RPC', async () => {
    const cause = {
      code: 'PGRST202',
      message: 'Could not find the function public.get_social_directory without parameters in the schema cache',
      details: 'database details must not be logged',
    }
    const { client } = clientWithRpc({ error: cause })

    await expect(fetchSocialDirectory(client)).rejects.toMatchObject({
      kind: 'backend_unavailable',
      operation: 'directory',
      databaseCode: 'PGRST202',
      rpcName: 'get_social_directory',
      diagnosticMessage: 'Required Supabase RPC is unavailable. Verify migrations and refresh the PostgREST schema cache.',
    })
  })

  it.each([
    [{ code: '42501', message: 'Social Follow requires a verified account' }, 'verification_required'],
    [{ code: '55000', message: 'Following requires a registered, listed social profile with a public identity' }, 'profile_required'],
    [{ code: '23514', message: 'Complete your display name or username before joining the social directory' }, 'profile_incomplete'],
    [{ code: 'P0002', message: 'Social profile is not available' }, 'profile_unavailable'],
    [{ code: '42501', message: 'permission denied' }, 'not_authorized'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint' }, 'conflict'],
    [{ code: '22023', message: 'Invalid follow request decision' }, 'invalid_request'],
    [{ code: 'PGRST301', message: 'upstream unavailable' }, 'backend_unavailable'],
    [{ code: 'P0002', message: 'Pending follow request was not found' }, 'conflict'],
    [{ code: '23514', message: 'A listed social profile requires a display name or username' }, 'profile_incomplete'],
    [{ message: 'Failed to fetch' }, 'backend_unavailable'],
  ])('maps expected database errors without exposing their raw messages', (cause, kind) => {
    const error = socialFollowErrorFrom(cause, 'follow')
    expect(error).toMatchObject({ kind, operation: 'follow', databaseCode: cause.code ?? null })
    expect(error.message).toBe('Social Follow follow failed')
    expect(error.message).not.toContain(cause.message)
    expect(error.cause).toBe(cause)
  })

  it('maps unknown database failures to a safe generic category while retaining diagnostics', () => {
    const cause = {
      code: 'XX000',
      message: 'sensitive database internals',
      details: 'private row value',
      hint: 'internal schema name',
    }
    const error = socialFollowErrorFrom(cause, 'directory')

    expect(error).toMatchObject({
      kind: 'unknown',
      operation: 'directory',
      databaseCode: 'XX000',
      message: 'Social Follow directory failed',
    })
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain(cause.message)
  })
})

describe('runSocialMutation', () => {
  it('does not report completion before mutation and authoritative refresh succeed', async () => {
    const calls: string[] = []
    await runSocialMutation(
      async () => { calls.push('mutation') },
      async () => { calls.push('refresh') },
    )
    expect(calls).toEqual(['mutation', 'refresh'])
  })

  it('refetches after a failed mutation and preserves the mutation error', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    await expect(runSocialMutation(
      async () => { throw new Error('request denied') },
      refresh,
    )).rejects.toThrow('request denied')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

