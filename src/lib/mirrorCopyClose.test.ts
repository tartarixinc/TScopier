import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  canRequestMirrorClose,
  requestMirrorCopyClose,
  waitForMirrorCopyClosed,
} from './mirrorCopyClose'

describe('canRequestMirrorClose', () => {
  it('accepts the states the RPC accepts and rejects the rest', () => {
    for (const state of ['open', 'uncertain', 'error', 'closing']) {
      expect(canRequestMirrorClose(state), state).toBe(true)
    }
    for (const state of ['closed', 'opening', '', 'garbage']) {
      expect(canRequestMirrorClose(state), state).toBe(false)
    }
    expect(canRequestMirrorClose(null)).toBe(false)
    expect(canRequestMirrorClose(undefined)).toBe(false)
  })
})

type RpcResult = { data: unknown; error: { message: string } | null }

function rpcClient(result: RpcResult): SupabaseClient {
  return {
    rpc: async () => result,
  } as unknown as SupabaseClient
}

describe('requestMirrorCopyClose', () => {
  it('calls the RPC with the mapping id and reports applied', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        return { data: true, error: null }
      },
    } as unknown as SupabaseClient
    expect(await requestMirrorCopyClose(client, 'map-1')).toEqual({ applied: true, error: null })
    expect(calls).toEqual([{ name: 'request_mirror_copy_close', args: { p_mapping_id: 'map-1' } }])
  })

  it('reports applied=false when nothing changed (already closed)', async () => {
    expect(await requestMirrorCopyClose(rpcClient({ data: false, error: null }), 'map-1'))
      .toEqual({ applied: false, error: null })
  })

  it('surfaces RPC errors without throwing', async () => {
    expect(await requestMirrorCopyClose(rpcClient({ data: null, error: { message: 'not authorized' } }), 'map-1'))
      .toEqual({ applied: false, error: 'not authorized' })
  })

  it('fails fast on a missing mapping id', async () => {
    expect(await requestMirrorCopyClose(rpcClient({ data: true, error: null }), ''))
      .toEqual({ applied: false, error: 'mapping_missing' })
  })
})

type StateResult = { data: { state: string } | null; error: { message: string } | null }

function pollClient(states: StateResult[]): SupabaseClient {
  let i = 0
  const next = (): StateResult => states[Math.min(i++, states.length - 1)]!
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => next(),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

const noSleep = async () => {}

describe('waitForMirrorCopyClosed', () => {
  it('returns closed once the worker flips the state', async () => {
    const client = pollClient([
      { data: { state: 'closing' }, error: null },
      { data: { state: 'closed' }, error: null },
    ])
    let clock = 0
    const result = await waitForMirrorCopyClosed(client, 'map-1', {
      timeoutMs: 10_000,
      pollMs: 1_000,
      now: () => (clock += 1_000),
      sleep: noSleep,
    })
    expect(result).toEqual({ outcome: 'closed', error: null })
  })

  it('times out when the state never becomes closed', async () => {
    const client = pollClient([{ data: { state: 'closing' }, error: null }])
    let clock = 0
    const result = await waitForMirrorCopyClosed(client, 'map-1', {
      timeoutMs: 3_000,
      pollMs: 1_000,
      now: () => (clock += 1_000),
      sleep: noSleep,
    })
    expect(result).toEqual({ outcome: 'timeout', error: null })
  })

  it('keeps polling through read errors and reports the last one on timeout', async () => {
    const client = pollClient([
      { data: null, error: { message: 'network down' } },
      { data: { state: 'closed' }, error: null },
    ])
    let clock = 0
    const result = await waitForMirrorCopyClosed(client, 'map-1', {
      timeoutMs: 10_000,
      pollMs: 1_000,
      now: () => (clock += 1_000),
      sleep: noSleep,
    })
    expect(result).toEqual({ outcome: 'closed', error: null })
  })

  it('reports read-error when the timeout is reached with only failed reads', async () => {
    const client = pollClient([{ data: null, error: { message: 'network down' } }])
    let clock = 0
    const result = await waitForMirrorCopyClosed(client, 'map-1', {
      timeoutMs: 2_000,
      pollMs: 1_000,
      now: () => (clock += 1_000),
      sleep: noSleep,
    })
    expect(result).toEqual({ outcome: 'read-error', error: 'network down' })
  })
})
