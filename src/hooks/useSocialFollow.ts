import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  fetchSocialDirectory,
  followSocialProfile,
  registerSocialProfile,
  removeSocialFollow,
  resolveSocialFollowRequest,
  runSocialMutation,
  setSocialProfileAccess,
  socialFollowErrorFrom,
  type SocialDirectoryProfile,
  type SocialFollowError,
  type SocialProfileAccess,
} from '../lib/socialFollow'

interface DirectorySnapshot {
  identity: string | null
  profiles: SocialDirectoryProfile[]
  loading: boolean
  error: SocialFollowError | null
}

interface PendingSnapshot {
  identity: string | null
  keys: ReadonlySet<string>
}

interface NoticeSnapshot {
  identity: string | null
  message: string | null
}

const EMPTY_PROFILES: SocialDirectoryProfile[] = []
const EMPTY_PENDING_KEYS: ReadonlySet<string> = new Set()

export function useSocialFollow() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>(() => ({
    identity: userId,
    profiles: [],
    loading: Boolean(userId),
    error: null,
  }))
  const [pendingSnapshot, setPendingSnapshot] = useState<PendingSnapshot>(() => ({
    identity: userId,
    keys: new Set(),
  }))
  const [noticeSnapshot, setNoticeSnapshot] = useState<NoticeSnapshot>(() => ({
    identity: userId,
    message: null,
  }))
  const pendingRef = useRef(new Set<string>())
  const identityRef = useRef(userId)
  const generationRef = useRef(0)
  const requestRef = useRef(0)
  const mountedRef = useRef(true)

  const isCurrent = useCallback((identity: string, generation: number, request?: number) => (
    mountedRef.current
    && identityRef.current === identity
    && generationRef.current === generation
    && (request == null || requestRef.current === request)
  ), [])

  const refreshIdentity = useCallback(async (identity: string, generation: number) => {
    if (!isCurrent(identity, generation)) return
    const request = ++requestRef.current
    setSnapshot(previous => ({
      identity,
      profiles: previous.identity === identity ? previous.profiles : [],
      loading: true,
      error: previous.identity === identity ? previous.error : null,
    }))
    try {
      const profiles = await fetchSocialDirectory(supabase)
      if (!isCurrent(identity, generation, request)) return
      setSnapshot({ identity, profiles, loading: false, error: null })
    } catch (cause) {
      if (!isCurrent(identity, generation, request)) return
      setSnapshot(previous => ({
        identity,
        profiles: previous.identity === identity ? previous.profiles : [],
        loading: false,
        error: socialFollowErrorFrom(cause, 'directory'),
      }))
    }
  }, [isCurrent])

  useEffect(() => {
    identityRef.current = userId
    const generation = ++generationRef.current
    requestRef.current += 1
    pendingRef.current.clear()

    const timer = window.setTimeout(() => {
      if (!mountedRef.current || generationRef.current !== generation) return
      setPendingSnapshot({ identity: userId, keys: new Set() })
      setNoticeSnapshot({ identity: userId, message: null })
      setSnapshot({ identity: userId, profiles: EMPTY_PROFILES, loading: Boolean(userId), error: null })
      if (userId) void refreshIdentity(userId, generation)
    }, 0)

    return () => {
      window.clearTimeout(timer)
      generationRef.current += 1
      requestRef.current += 1
    }
  }, [refreshIdentity, userId])

  useEffect(() => {
    mountedRef.current = true
    const pending = pendingRef.current
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      requestRef.current += 1
      pending.clear()
    }
  }, [])

  const refresh = useCallback(async () => {
    const identity = identityRef.current
    if (!identity) return
    await refreshIdentity(identity, generationRef.current)
  }, [refreshIdentity])

  const run = useCallback(async (key: string, mutate: () => Promise<void>) => {
    const identity = userId
    const generation = generationRef.current
    if (!identity || !isCurrent(identity, generation) || pendingRef.current.has(key)) return

    pendingRef.current.add(key)
    setPendingSnapshot({ identity, keys: new Set(pendingRef.current) })
    setNoticeSnapshot({ identity, message: null })
    setSnapshot(previous => ({
      identity,
      profiles: previous.identity === identity ? previous.profiles : [],
      loading: previous.identity === identity && previous.loading,
      error: null,
    }))

    try {
      await runSocialMutation(mutate, () => refreshIdentity(identity, generation))
      if (isCurrent(identity, generation)) {
        setNoticeSnapshot({ identity, message: key })
      }
    } catch (cause) {
      if (isCurrent(identity, generation)) {
        setSnapshot(previous => ({
          identity,
          profiles: previous.identity === identity ? previous.profiles : [],
          loading: false,
          error: socialFollowErrorFrom(cause, 'mutation'),
        }))
      }
    } finally {
      if (isCurrent(identity, generation)) {
        pendingRef.current.delete(key)
        setPendingSnapshot({ identity, keys: new Set(pendingRef.current) })
      }
    }
  }, [isCurrent, refreshIdentity, userId])

  const register = useCallback(
    () => run('register', () => registerSocialProfile(supabase)),
    [run],
  )
  const setAccess = useCallback(
    (access: SocialProfileAccess) => run('access', () => setSocialProfileAccess(supabase, access)),
    [run],
  )
  const follow = useCallback(
    (profileUserId: string) => run(`outgoing:${profileUserId}`, async () => {
      await followSocialProfile(supabase, profileUserId)
    }),
    [run],
  )
  const remove = useCallback(
    (profileUserId: string) => run(`outgoing:${profileUserId}`, () => removeSocialFollow(supabase, profileUserId)),
    [run],
  )
  const resolve = useCallback(
    (followerUserId: string, decision: 'accepted' | 'declined') => (
      run(`incoming:${followerUserId}`, () => resolveSocialFollowRequest(supabase, followerUserId, decision))
    ),
    [run],
  )

  const activeSnapshot = snapshot.identity === userId
    ? snapshot
    : { identity: userId, profiles: [], loading: Boolean(userId), error: null }
  const pendingKeys = pendingSnapshot.identity === userId ? pendingSnapshot.keys : EMPTY_PENDING_KEYS
  const currentProfile = useMemo(
    () => activeSnapshot.profiles.find(profile => profile.isSelf) ?? null,
    [activeSnapshot.profiles],
  )

  return {
    profiles: activeSnapshot.profiles,
    currentProfile,
    loading: activeSnapshot.loading,
    error: activeSnapshot.error,
    success: noticeSnapshot.identity === userId ? noticeSnapshot.message : null,
    pendingKeys,
    refresh,
    register,
    setAccess,
    follow,
    remove,
    resolve,
  }
}
