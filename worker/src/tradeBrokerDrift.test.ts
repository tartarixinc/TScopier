import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyBrokerDriftRepairs,
  GhostObservation,
  MIN_GHOST_GAP_MS,
  planBrokerDrift,
  type DriftRow,
  type LiveTicketHit,
} from './tradeBrokerDrift'

function row(overrides: Partial<DriftRow> & { id: string }): DriftRow {
  return {
    user_id: 'user-1',
    broker_account_id: 'broker-1',
    metaapi_order_id: '100',
    status: 'open',
    signal_id: 'signal-1',
    ...overrides,
  }
}

function hit(overrides: Partial<LiveTicketHit> & { ticket: number }): LiveTicketHit {
  return {
    filled: true,
    brokerAccountId: 'broker-1',
    userId: 'user-1',
    ...overrides,
  }
}

describe('planBrokerDrift', () => {
  it('reopens a closed row when the broker still holds the position on its own account', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', status: 'closed' })],
      live: [hit({ ticket: 100 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.reopen, [{
      row: row({ id: 't1', status: 'closed' }),
      status: 'open',
      brokerAccountId: 'broker-1',
    }])
    assert.deepEqual(plan.missingOnce, [])
    assert.deepEqual(plan.attach, [])
    assert.deepEqual(plan.unknown, [])
  })

  it('reopens as pending when the live ticket is only a resting order', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', status: 'closed', metaapi_order_id: '555' })],
      live: [hit({ ticket: 555, filled: false })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.reopen.map(r => r.status), ['pending'])
  })

  it('attaches a live row that never got a broker account link', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', broker_account_id: null })],
      live: [hit({ ticket: 100, brokerAccountId: 'broker-9' })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.attach, [{
      row: row({ id: 't1', broker_account_id: null }),
      brokerAccountId: 'broker-9',
    }])
    // open + live: nothing to reopen
    assert.deepEqual(plan.reopen, [])
  })

  it('does not attach when the ticket exists on several accounts of the user', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', broker_account_id: null, metaapi_order_id: '77' })],
      live: [
        hit({ ticket: 77, brokerAccountId: 'broker-1' }),
        hit({ ticket: 77, brokerAccountId: 'broker-2' }),
      ],
      fullyProbedUsers: new Set(['user-1']),
    })
    // ambiguous: no guess in either direction
    assert.deepEqual(plan.attach, [])
    assert.deepEqual(plan.reopen, [])
    assert.deepEqual(plan.missingOnce, [])
  })

  it('judges a row only against the account it belongs to', () => {
    const plan = planBrokerDrift({
      // the same ticket number lives on a *different* account of this user
      rows: [row({ id: 't1', broker_account_id: 'broker-1', metaapi_order_id: '77' })],
      live: [hit({ ticket: 77, brokerAccountId: 'broker-2' })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.reopen, [])
    assert.deepEqual(plan.missingOnce.map(r => r.id), ['t1'])
  })

  it('reports a live position that has no trade row at all', () => {
    const plan = planBrokerDrift({
      rows: [],
      live: [hit({ ticket: 777 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.unknown, [{ userId: 'user-1', ticket: 777 }])
  })

  it('flags an open row as missing once when its user was fully probed', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', metaapi_order_id: '100' }), row({ id: 't2', metaapi_order_id: '200' })],
      live: [hit({ ticket: 100 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.missingOnce.map(r => r.id), ['t2'])
  })

  it('never flags a row when any account of that user could not be probed', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', metaapi_order_id: '100' })],
      live: [],
      fullyProbedUsers: new Set(),
    })
    assert.deepEqual(plan.missingOnce, [])
    assert.deepEqual(plan.reopen, [])
  })

  it('ignores rows without a verifiable ticket when deciding ghosts', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', metaapi_order_id: null }), row({ id: 't2', metaapi_order_id: '0' })],
      live: [],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.missingOnce, [])
  })

  it('ignores closed rows that are not live (nothing to reopen)', () => {
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', status: 'closed', metaapi_order_id: '100' })],
      live: [hit({ ticket: 999 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    assert.deepEqual(plan.reopen, [])
    // a closed row is not a ghost either — the forward loop owns closes
    assert.deepEqual(plan.missingOnce, [])
  })
})

describe('GhostObservation', () => {
  it('needs two passes at least the minimum gap apart before confirming', () => {
    const ghosts = new GhostObservation()
    assert.deepEqual(ghosts.confirm(['a'], 1_000), [])
    // still inside the gap: a woken tick seconds later must not confirm
    assert.deepEqual(ghosts.confirm(['a'], 1_000 + MIN_GHOST_GAP_MS - 1), [])
    assert.deepEqual(ghosts.confirm(['a'], 1_000 + MIN_GHOST_GAP_MS), ['a'])
  })

  it('honours an explicit gap so a too-early second pass cannot confirm', () => {
    const ghosts = new GhostObservation()
    ghosts.confirm(['a'], 1_000, 60_000)
    assert.deepEqual(ghosts.confirm(['a'], 61_000, 60_000), ['a'])
    const other = new GhostObservation()
    other.confirm(['b'], 1_000, 60_000)
    assert.deepEqual(other.confirm(['b'], 30_000, 60_000), [])
    // the original timestamp survives the skipped attempt
    assert.deepEqual(other.confirm(['b'], 61_000, 60_000), ['b'])
  })

  it('forgets a row that reappears in between', () => {
    const ghosts = new GhostObservation()
    ghosts.confirm(['a'], 1_000, 60_000)
    ghosts.confirm([], 61_000, 60_000) // position came back
    assert.deepEqual(ghosts.confirm(['a'], 121_000, 60_000), [])
    assert.deepEqual(ghosts.confirm(['a'], 181_000, 60_000), ['a'])
  })

  it('reset clears the memory', () => {
    const ghosts = new GhostObservation()
    ghosts.confirm(['a'], 1_000, 60_000)
    ghosts.reset()
    assert.deepEqual(ghosts.confirm(['a'], 61_000, 60_000), [])
  })
})

describe('applyBrokerDriftRepairs', () => {
  type Recorded = { payload: Record<string, unknown>; filters: Array<{ col: string; args: unknown[] }> }

  function fakeSupabase(
    records: Recorded[],
    options: { data?: Array<{ id: string }>; error?: string } = {},
  ) {
    const chain = {
      update(payload: Record<string, unknown>) {
        records.push({ payload, filters: [] })
        return chain
      },
      eq(col: string, ...args: unknown[]) {
        records[records.length - 1]!.filters.push({ col, args })
        return chain
      },
      is(col: string, ...args: unknown[]) {
        records[records.length - 1]!.filters.push({ col, args })
        return chain
      },
      in(col: string, ...args: unknown[]) {
        // PostgREST receives `in` values as one array argument.
        const flat = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
        records[records.length - 1]!.filters.push({ col, args: flat })
        return chain
      },
      select(...args: unknown[]) {
        if (records.length) records[records.length - 1]!.filters.push({ col: 'select', args })
        return chain
      },
      then(resolve: (value: unknown) => unknown) {
        const body = options.error
          ? { error: { message: options.error }, data: null }
          : { error: null, data: options.data ?? [{ id: 'row-1' }] }
        return Promise.resolve(body).then(resolve)
      },
    }
    return { from: () => chain } as never
  }

  it('reopens only rows still marked closed, and counts what the database changed', async () => {
    const records: Recorded[] = []
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', status: 'closed' })],
      live: [hit({ ticket: 100 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    const result = await applyBrokerDriftRepairs(
      fakeSupabase(records, { data: [{ id: 't1' }] }),
      plan,
      [],
    )
    assert.equal(result.reopened, 1)
    assert.deepEqual(records[0]!.payload, { status: 'open', closed_at: null, close_price: null })
    assert.deepEqual(records[0]!.filters, [
      { col: 'id', args: ['t1'] },
      { col: 'status', args: ['closed'] },
      { col: 'select', args: ['id'] },
    ])
  })

  it('reports zero when the guard rejected the reopen', async () => {
    const records: Recorded[] = []
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', status: 'closed' })],
      live: [hit({ ticket: 100 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    const result = await applyBrokerDriftRepairs(
      fakeSupabase(records, { data: [] }), // row changed between plan and apply
      plan,
      [],
    )
    assert.equal(result.reopened, 0)
  })

  it('attaches only while the row is still unlinked', async () => {
    const records: Recorded[] = []
    const plan = planBrokerDrift({
      rows: [row({ id: 't1', broker_account_id: null })],
      live: [hit({ ticket: 100, brokerAccountId: 'broker-9' })],
      fullyProbedUsers: new Set(['user-1']),
    })
    const result = await applyBrokerDriftRepairs(
      fakeSupabase(records, { data: [{ id: 't1' }] }),
      plan,
      [],
    )
    assert.equal(result.attached, 1)
    assert.deepEqual(records[0]!.payload, { broker_account_id: 'broker-9' })
    assert.deepEqual(records[0]!.filters, [
      { col: 'id', args: ['t1'] },
      { col: 'broker_account_id', args: [null] },
      { col: 'select', args: ['id'] },
    ])
  })

  it('closes confirmed ghosts only for open/pending rows', async () => {
    const records: Recorded[] = []
    const ghosts = [row({ id: 'g1', broker_account_id: null, signal_id: null })]
    const result = await applyBrokerDriftRepairs(
      fakeSupabase(records, { data: [{ id: 'g1' }] }),
      { reopen: [], attach: [], unknown: [], missingOnce: [] },
      ghosts,
    )
    assert.equal(result.closed, 1)
    assert.equal(records[0]!.payload.status, 'closed')
    assert.ok((records[0]!.payload.closed_at as string).length > 0)
    assert.deepEqual(records[0]!.filters, [
      { col: 'id', args: ['g1'] },
      { col: 'status', args: ['open', 'pending'] },
      { col: 'select', args: ['id'] },
    ])
  })

  it('writes nothing for unknown live positions (report only)', async () => {
    const records: Recorded[] = []
    const plan = planBrokerDrift({
      rows: [],
      live: [hit({ ticket: 777 })],
      fullyProbedUsers: new Set(['user-1']),
    })
    const result = await applyBrokerDriftRepairs(fakeSupabase(records), plan, [])
    assert.deepEqual(records, [])
    assert.equal(result.reopened, 0)
    assert.equal(result.closed, 0)
  })
})
