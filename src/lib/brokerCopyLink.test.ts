import { describe, expect, it } from 'vitest'
import {
  fetchMirrorCopyLinkStates,
  mirrorCopyStatusTone,
  setMirrorCopyLinkStatus,
  type MirrorCopyLinkStateRow,
} from './brokerCopyLink'

function state(patch: Partial<MirrorCopyLinkStateRow> = {}): MirrorCopyLinkStateRow {
  return {
    link_id: 'link-1',
    desired_status: 'paused',
    status: 'paused',
    error_code: null,
    error_detail: null,
    ...patch,
  }
}

describe('mirror copy status', () => {
  it('treats an unknown link as neutral', () => {
    expect(mirrorCopyStatusTone(undefined)).toBe('neutral')
  })

  it('shows success when the user wants copying and the worker agrees', () => {
    expect(mirrorCopyStatusTone(state({ desired_status: 'active', status: 'active' }))).toBe('success')
  })

  it('shows a warning while active copying is not yet acknowledged', () => {
    expect(mirrorCopyStatusTone(state({ desired_status: 'active', status: 'pending' }))).toBe('warning')
    expect(mirrorCopyStatusTone(state({ desired_status: 'paused', status: 'paused' }))).toBe('warning')
  })

  it('treats stopped as neutral and any error as an error', () => {
    expect(mirrorCopyStatusTone(state({ desired_status: 'stopped', status: 'stopped' }))).toBe('neutral')
    expect(mirrorCopyStatusTone(state({ status: 'error' }))).toBe('error')
    expect(mirrorCopyStatusTone(state({ status: 'unsupported_provider' }))).toBe('error')
    expect(mirrorCopyStatusTone(state({ error_code: 'BROKER_DISCONNECTED' }))).toBe('error')
  })
})

describe('mirror copy link actions', () => {
  it('asks the database to change the link status', async () => {
    const calls: Array<{ name: string; args: unknown }> = []
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args })
        return { error: null }
      },
    }
    const result = await setMirrorCopyLinkStatus(client as never, 'link-1', 'active')
    expect(result.error).toBeNull()
    expect(calls).toEqual([{
      name: 'set_mirror_copy_link_status',
      args: { p_link_id: 'link-1', p_status: 'active' },
    }])
  })

  it('returns the database error unchanged', async () => {
    const client = { rpc: async () => ({ error: { message: 'not authorized' } }) }
    expect((await setMirrorCopyLinkStatus(client as never, 'link-1', 'stopped')).error).toBe('not authorized')
  })

  it('does not query when there are no links', async () => {
    const client = { from: () => { throw new Error('must not query') } }
    expect(await fetchMirrorCopyLinkStates(client as never, [])).toEqual({ states: {}, error: null })
  })
})
