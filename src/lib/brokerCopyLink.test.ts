import { describe, expect, it } from 'vitest'
import {
  MIRROR_STOP_TIMEOUT_MESSAGE,
  disconnectBrokerCopyLinkSafely,
  fetchBrokerCopyDestinationLinks,
  fetchMirrorCopyLinkStates,
  humanizeMirrorDeleteError,
  isMirrorOpenCopiesError,
  mirrorCopyStatusTone,
  setMirrorCopyLinkStatus,
  stopMirrorCopyLinkAndWait,
  type MirrorCopyLinkStateRow,
} from './brokerCopyLink'

const GUARD_MESSAGE =
  'MIRROR_OPEN_COPIES: Remove blocked: 2 copied trade(s) are still open on the slave account. Stop copying on the Mirror Account page first (that closes them), then remove the link.'

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

  it('warns while a stop request has not been confirmed yet', () => {
    expect(mirrorCopyStatusTone(state({ desired_status: 'stopped', status: 'active' }))).toBe('warning')
    expect(mirrorCopyStatusTone(state({ desired_status: 'stopped', status: 'pending' }))).toBe('warning')
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

describe('fetchBrokerCopyDestinationLinks', () => {
  function destinationClient(rows: unknown[], error?: { message: string }) {
    return {
      from: (table: string) => {
        expect(table).toBe('broker_copy_links')
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: error ? null : rows, error: error ?? null }),
            }),
          }),
        }
      },
    }
  }

  it('returns the links where the broker is the slave', async () => {
    const client = destinationClient([
      {
        id: 'link-1',
        source_broker_account_id: 'master-1',
        destination_broker_account_id: 'slave-1',
        manual_settings: { fixed_lot: 0.02 },
      },
    ])
    const result = await fetchBrokerCopyDestinationLinks(client as never, 'user-1', 'slave-1')
    expect(result.error).toBeNull()
    expect(result.links).toHaveLength(1)
    expect(result.links[0]).toMatchObject({
      id: 'link-1',
      source_broker_account_id: 'master-1',
      destination_broker_account_id: 'slave-1',
    })
    expect(result.links[0].manual_settings.fixed_lot).toBe(0.02)
  })

  it('treats a missing table as no links', async () => {
    const client = destinationClient([], {
      message: 'relation "public.broker_copy_links" does not exist in the schema cache',
    })
    expect(await fetchBrokerCopyDestinationLinks(client as never, 'user-1', 'slave-1'))
      .toEqual({ links: [], error: null })
  })

  it('surfaces other database errors', async () => {
    const client = destinationClient([], { message: 'not authorized' })
    expect(await fetchBrokerCopyDestinationLinks(client as never, 'user-1', 'slave-1'))
      .toEqual({ links: [], error: 'not authorized' })
  })
})

interface FakeOptions {
  /** Error per rpc call; the last entry repeats. */
  rpcErrors?: Array<string | null>
  /** Error per link delete; the last entry repeats. */
  deleteErrors?: Array<string | null>
  /** Rows per mirror_copy_link_state read; the last entry repeats. */
  stateReads?: Array<MirrorCopyLinkStateRow[]>
}

/** Minimal supabase stand-in: rpc, link deletes, and state reads. */
function fakeClient(options: FakeOptions = {}) {
  let rpcIdx = 0
  let deleteIdx = 0
  let stateIdx = 0
  const log: string[] = []
  const repeat = <T>(list: T[] | undefined, index: number): T | undefined =>
    list?.length ? list[Math.min(index, list.length - 1)] : undefined
  const client = {
    rpc: async (name: string, args: unknown) => {
      log.push(`rpc:${(args as { p_status: string }).p_status}`)
      const message = repeat(options.rpcErrors, rpcIdx++)
      return { error: message ? { message } : null }
    },
    from(table: string) {
      if (table === 'broker_copy_links') {
        return {
          delete: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => {
                  log.push('delete')
                  const message = repeat(options.deleteErrors, deleteIdx++)
                  return Promise.resolve({ error: message ? { message } : null })
                },
              }),
            }),
          }),
        }
      }
      if (table === 'mirror_copy_link_state') {
        return {
          select: () => ({
            in: () => {
              log.push('read-state')
              return Promise.resolve({ data: repeat(options.stateReads, stateIdx++) ?? [], error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { client: client as never, log }
}

/** Clock-driven wait options so timeouts resolve without real delays. */
function fastWait(timeoutMs = 100, pollMs = 10) {
  let clock = 0
  return {
    options: {
      timeoutMs,
      pollMs,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
    },
    ticks: () => Math.floor(timeoutMs / pollMs),
  }
}

const linkRow = {
  id: 'link-1',
  source_broker_account_id: 'master-1',
  destination_broker_account_id: 'slave-1',
}

describe('mirror open-copies error marker', () => {
  it('recognises the guard refusal', () => {
    expect(isMirrorOpenCopiesError(GUARD_MESSAGE)).toBe(true)
    expect(isMirrorOpenCopiesError('permission denied')).toBe(false)
    expect(isMirrorOpenCopiesError(null)).toBe(false)
  })

  it('strips the marker before the message reaches the user', () => {
    expect(humanizeMirrorDeleteError(GUARD_MESSAGE)).toBe(
      'Remove blocked: 2 copied trade(s) are still open on the slave account. Stop copying on the Mirror Account page first (that closes them), then remove the link.',
    )
    expect(humanizeMirrorDeleteError('plain failure')).toBe('plain failure')
    expect(humanizeMirrorDeleteError(null)).toBeNull()
  })
})

describe('stopMirrorCopyLinkAndWait', () => {
  it('returns as soon as the worker confirms the stop', async () => {
    const { client, log } = fakeClient({
      rpcErrors: [null],
      stateReads: [[state({ desired_status: 'stopped', status: 'stopped' })]],
    })
    const { options } = fastWait()
    const result = await stopMirrorCopyLinkAndWait(client, 'link-1', options)
    expect(result).toEqual({ stopped: true, error: null })
    expect(log).toEqual(['rpc:stopped', 'read-state'])
  })

  it('times out when the worker never confirms', async () => {
    const { client, log } = fakeClient({
      rpcErrors: [null],
      stateReads: [[state({ desired_status: 'stopped', status: 'active' })]],
    })
    const { options, ticks } = fastWait()
    const result = await stopMirrorCopyLinkAndWait(client, 'link-1', options)
    expect(result).toEqual({ stopped: false, error: null })
    expect(log.filter(entry => entry === 'read-state')).toHaveLength(ticks() + 1)
  })

  it('surfaces the rpc error and never reads state', async () => {
    const { client, log } = fakeClient({ rpcErrors: ['not authorized'] })
    const result = await stopMirrorCopyLinkAndWait(client, 'link-1', fastWait().options)
    expect(result).toEqual({ stopped: false, error: 'not authorized' })
    expect(log).toEqual(['rpc:stopped'])
  })

  it('fails fast when the worker records a permanent stop failure', async () => {
    const { client, log } = fakeClient({
      rpcErrors: [null],
      stateReads: [[state({
        desired_status: 'stopped',
        status: 'error',
        error_code: 'LIVE_EXECUTION_DISABLED',
        error_detail: 'Stop requested on a live account; live execution is disabled',
      })]],
    })
    const result = await stopMirrorCopyLinkAndWait(client, 'link-1', fastWait().options)
    expect(result).toEqual({
      stopped: false,
      error: 'LIVE_EXECUTION_DISABLED: Stop requested on a live account; live execution is disabled',
    })
    expect(log).toEqual(['rpc:stopped', 'read-state'])
  })

  it('keeps waiting on a recoverable worker error', async () => {
    const { client } = fakeClient({
      rpcErrors: [null],
      stateReads: [
        [state({ desired_status: 'stopped', status: 'error', error_code: 'BROKER_DISCONNECTED' })],
        [state({ desired_status: 'stopped', status: 'stopped' })],
      ],
    })
    const result = await stopMirrorCopyLinkAndWait(client, 'link-1', fastWait().options)
    expect(result).toEqual({ stopped: true, error: null })
  })
})

describe('disconnectBrokerCopyLinkSafely', () => {
  it('deletes straight away when no copied trades are open', async () => {
    const { client, log } = fakeClient({ deleteErrors: [null] })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result).toEqual({ removed: true, error: null })
    expect(log).toEqual(['delete'])
  })

  it('stops the link, waits for the flatten, then retries the delete', async () => {
    const { client, log } = fakeClient({
      deleteErrors: [GUARD_MESSAGE, null],
      rpcErrors: [null],
      stateReads: [[state({ desired_status: 'stopped', status: 'stopped' })]],
    })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result).toEqual({ removed: true, error: null })
    expect(log).toEqual(['delete', 'rpc:stopped', 'read-state', 'delete'])
  })

  it('keeps the link and explains when the flatten is not confirmed', async () => {
    const { client, log } = fakeClient({
      deleteErrors: [GUARD_MESSAGE],
      rpcErrors: [null],
      stateReads: [[state({ desired_status: 'stopped', status: 'active' })]],
    })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result).toEqual({ removed: false, error: MIRROR_STOP_TIMEOUT_MESSAGE })
    expect(log.filter(entry => entry === 'delete')).toHaveLength(1)
  })

  it('surfaces a stop failure without retrying the delete', async () => {
    const { client, log } = fakeClient({
      deleteErrors: [GUARD_MESSAGE],
      rpcErrors: ['not authorized'],
    })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result).toEqual({ removed: false, error: 'not authorized' })
    expect(log.filter(entry => entry === 'delete')).toHaveLength(1)
  })

  it('passes ordinary delete errors through without stopping', async () => {
    const { client, log } = fakeClient({ deleteErrors: ['permission denied'] })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result).toEqual({ removed: false, error: 'permission denied' })
    expect(log).toEqual(['delete'])
  })

  it('reports a clean message when copies survive a completed stop', async () => {
    const { client } = fakeClient({
      deleteErrors: [GUARD_MESSAGE, GUARD_MESSAGE],
      rpcErrors: [null],
      stateReads: [[state({ desired_status: 'stopped', status: 'stopped' })]],
    })
    const result = await disconnectBrokerCopyLinkSafely(client, 'user-1', linkRow, fastWait().options)
    expect(result.removed).toBe(false)
    expect(result.error).toContain('copied trade(s) are still open')
    expect(isMirrorOpenCopiesError(result.error)).toBe(false)
  })
})
