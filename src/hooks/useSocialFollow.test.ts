// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SocialDirectoryProfile } from '../lib/socialFollow'
import { fetchSocialDirectory, followSocialProfile } from '../lib/socialFollow'
import { useSocialFollow } from './useSocialFollow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  fetchDirectory: vi.fn(),
  followProfile: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mocks.user,
    session: null,
    loading: false,
    signOut: vi.fn(),
  }),
}))

vi.mock('../lib/supabase', () => ({ supabase: {} }))

vi.mock('../lib/socialFollow', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/socialFollow')>(),
  fetchSocialDirectory: mocks.fetchDirectory,
  followSocialProfile: mocks.followProfile,
  registerSocialProfile: vi.fn(),
  removeSocialFollow: vi.fn(),
  resolveSocialFollowRequest: vi.fn(),
  setSocialProfileAccess: vi.fn(),
}))

const fetchDirectoryMock = vi.mocked(fetchSocialDirectory)
const followProfileMock = vi.mocked(followSocialProfile)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function profile(id: string, isSelf = true): SocialDirectoryProfile {
  return {
    profileUserId: id,
    displayName: `User ${id}`,
    username: `user-${id}`,
    country: '',
    access: 'open',
    isSelf,
    followerCount: 0,
    followingCount: 0,
    viewerRelationshipStatus: null,
    followsViewerStatus: null,
    averageRating: null,
    reviewCount: 0,
    viewerRating: null,
    sharesTradeHistory: false,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let hookApi: ReturnType<typeof useSocialFollow> | null = null
let captureCount = 0

function Harness() {
  const hook = useSocialFollow()
  useEffect(() => {
    hookApi = hook
    captureCount += 1
  })
  return null
}

async function renderFor(userId: string | null): Promise<void> {
  mocks.user = userId ? { id: userId } : null
  await act(async () => {
    root!.render(createElement(Harness))
  })
}

async function flushIdentityTimer(): Promise<void> {
  await act(async () => {
    vi.runOnlyPendingTimers()
    await Promise.resolve()
  })
}

async function settle<T>(pending: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    pending.resolve(value)
    await pending.promise
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  hookApi = null
  captureCount = 0
  mocks.user = null
  fetchDirectoryMock.mockReset()
  followProfileMock.mockReset()
  vi.useRealTimers()
})

describe('useSocialFollow authentication transitions', () => {
  it('clears user A state and ignores a pending directory result after logout', async () => {
    const requestA = deferred<SocialDirectoryProfile[]>()
    fetchDirectoryMock.mockReturnValueOnce(requestA.promise)

    await renderFor('A')
    await flushIdentityTimer()
    expect(fetchDirectoryMock).toHaveBeenCalledTimes(1)

    await renderFor(null)
    await flushIdentityTimer()
    expect(hookApi).toMatchObject({ profiles: [], loading: false, error: null })

    await settle(requestA, [profile('A')])
    expect(hookApi).toMatchObject({ profiles: [], loading: false, error: null })
  })

  it('keeps user B data when user A request completes later', async () => {
    const requestA = deferred<SocialDirectoryProfile[]>()
    const requestB = deferred<SocialDirectoryProfile[]>()
    fetchDirectoryMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise)

    await renderFor('A')
    await flushIdentityTimer()
    await renderFor('B')
    await flushIdentityTimer()

    await settle(requestB, [profile('B')])
    expect(hookApi!.profiles.map(item => item.profileUserId)).toEqual(['B'])

    await settle(requestA, [profile('A')])
    expect(hookApi!.profiles.map(item => item.profileUserId)).toEqual(['B'])
  })

  it('ignores a mutation completion after identity changes', async () => {
    const initialA = deferred<SocialDirectoryProfile[]>()
    const mutationA = deferred<'accepted'>()
    const requestB = deferred<SocialDirectoryProfile[]>()
    fetchDirectoryMock
      .mockReturnValueOnce(initialA.promise)
      .mockReturnValueOnce(requestB.promise)
    followProfileMock.mockReturnValueOnce(mutationA.promise)

    await renderFor('A')
    await flushIdentityTimer()
    await settle(initialA, [profile('A')])

    let mutationPromise!: Promise<void>
    await act(async () => {
      mutationPromise = hookApi!.follow('target')
      await Promise.resolve()
    })
    expect(hookApi!.pendingKeys.has('outgoing:target')).toBe(true)

    await renderFor('B')
    await flushIdentityTimer()
    await settle(requestB, [profile('B')])

    await act(async () => {
      mutationA.resolve('accepted')
      await mutationPromise
    })

    expect(hookApi!.profiles.map(item => item.profileUserId)).toEqual(['B'])
    expect(hookApi!.pendingKeys.size).toBe(0)
    expect(fetchDirectoryMock).toHaveBeenCalledTimes(2)
  })

  it('does not publish a pending request result after unmount', async () => {
    const request = deferred<SocialDirectoryProfile[]>()
    fetchDirectoryMock.mockReturnValueOnce(request.promise)

    await renderFor('A')
    await flushIdentityTimer()
    const capturesAtUnmount = captureCount

    await act(async () => {
      root!.unmount()
    })
    root = null
    await settle(request, [profile('A')])

    expect(captureCount).toBe(capturesAtUnmount)
  })

  it('ignores an older refresh after a newer refresh succeeds', async () => {
    const initial = deferred<SocialDirectoryProfile[]>()
    const older = deferred<SocialDirectoryProfile[]>()
    const newer = deferred<SocialDirectoryProfile[]>()
    fetchDirectoryMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)

    await renderFor('A')
    await flushIdentityTimer()
    await settle(initial, [profile('initial')])

    let olderPromise!: Promise<void>
    let newerPromise!: Promise<void>
    await act(async () => {
      olderPromise = hookApi!.refresh()
      newerPromise = hookApi!.refresh()
      await Promise.resolve()
    })

    await settle(newer, [profile('newer')])
    await newerPromise
    expect(hookApi!.profiles.map(item => item.profileUserId)).toEqual(['newer'])

    await settle(older, [profile('older')])
    await olderPromise
    expect(hookApi!.profiles.map(item => item.profileUserId)).toEqual(['newer'])
  })
})
