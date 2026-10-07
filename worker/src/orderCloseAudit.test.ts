import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditOrderClose,
  registerOrderCloseAuditSupabase,
  registerOrderCloseAuditSink,
} from './orderCloseAudit'

function makeSupabaseMock() {
  const inserted: unknown[] = []
  const state = {
    account: null as { id?: string; user_id?: string } | null,
    trade: null as { signal_id?: string | null } | null,
    filter: null as { kind: 'eq' | 'or'; value: string } | null,
    lookupError: null as { code: string; message: string } | null,
  }
  const accountLookup = (): { data: { id?: string; user_id?: string } | null; error: { code: string; message: string } | null } => ({
    data: state.lookupError ? null : state.account,
    error: state.lookupError,
  })
  return {
    state,
    inserted,
    supabase: {
      from: (table: string) => {
        if (table === 'broker_accounts') {
          return {
            select: () => ({
              eq: (column: string, value: string) => {
                state.filter = { kind: 'eq', value: `${column}=${value}` }
                return { maybeSingle: async () => accountLookup() }
              },
              or: (expression: string) => {
                state.filter = { kind: 'or', value: expression }
                return { maybeSingle: async () => accountLookup() }
              },
            }),
          }
        }
        if (table === 'trades') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: state.trade, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'trade_execution_logs') {
          return {
            insert: (row: unknown) => {
              inserted.push(row)
              return {}
            },
          }
        }
        throw new Error(`unexpected table: ${table}`)
      },
    },
  }
}

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0))
}

describe('orderCloseAudit persistence', () => {
  it('persists with user_id + signal_id resolved through broker_accounts → trades', async () => {
    const mock = makeSupabaseMock()
    mock.state.account = { id: 'broker-uuid', user_id: 'user-1' }
    mock.state.trade = { signal_id: 'sig-1' }
    registerOrderCloseAuditSupabase(mock.supabase as never)

    auditOrderClose({
      source: 'fxsocket',
      accountId: 'fx-account-1',
      ticket: 1278201,
      volume: 0.5,
      ok: false,
      message: 'unknown ticket',
    })
    await flush()
    registerOrderCloseAuditSink(null)

    assert.equal(mock.inserted.length, 1)
    const row = mock.inserted[0] as Record<string, unknown>
    assert.equal(row.user_id, 'user-1')
    assert.equal(row.signal_id, 'sig-1')
    assert.equal(row.action, 'order_close_audit')
    assert.equal(row.status, 'failed')
    assert.equal(row.error_message, 'unknown ticket')
  })

  it('skips the insert when the trade row is missing (signal_id is NOT NULL)', async () => {
    const mock = makeSupabaseMock()
    mock.state.account = { id: 'broker-uuid', user_id: 'user-1' }
    mock.state.trade = null
    registerOrderCloseAuditSupabase(mock.supabase as never)

    auditOrderClose({
      source: 'fx_v2',
      accountId: 'fx-account-2',
      ticket: 42,
      ok: true,
    })
    await flush()
    registerOrderCloseAuditSink(null)

    assert.equal(mock.inserted.length, 0)
  })

  it('does not attempt the insert when no broker account resolves', async () => {
    const mock = makeSupabaseMock()
    mock.state.account = null
    registerOrderCloseAuditSupabase(mock.supabase as never)

    auditOrderClose({
      source: 'fxsocket',
      accountId: 'fx-account-3',
      ticket: 7,
      ok: false,
    })
    await flush()
    registerOrderCloseAuditSink(null)

    assert.equal(mock.inserted.length, 0)
  })

  it('resolves an MTAPI close through mtapi_session_id', async () => {
    const mock = makeSupabaseMock()
    mock.state.account = { id: 'broker-uuid', user_id: 'user-1' }
    mock.state.trade = { signal_id: 'sig-1' }
    registerOrderCloseAuditSupabase(mock.supabase as never)

    auditOrderClose({
      source: 'mtapi',
      accountId: '35506c47-991b-4215-99e9-a1f618b2b1fd',
      ticket: 3321526729,
      ok: true,
      message: 'Started',
    })
    await flush()
    registerOrderCloseAuditSink(null)

    assert.equal(mock.inserted.length, 1)
    assert.equal(mock.state.filter?.kind, 'or')
    assert.match(
      mock.state.filter?.value ?? '',
      /mtapi_session_id\.eq\.35506c47-991b-4215-99e9-a1f618b2b1fd/,
    )
    const row = mock.inserted[0] as Record<string, unknown>
    assert.equal(row.signal_id, 'sig-1')
  })

  it('falls back to a single-column lookup for an id with filter-unsafe characters', async () => {
    const mock = makeSupabaseMock()
    mock.state.account = { id: 'broker-uuid', user_id: 'user-1' }
    mock.state.trade = { signal_id: 'sig-1' }
    registerOrderCloseAuditSupabase(mock.supabase as never)

    auditOrderClose({
      source: 'fxsocket',
      accountId: 'fx,account)eq.hacked',
      ticket: 7,
      ok: true,
    })
    await flush()
    registerOrderCloseAuditSink(null)

    assert.equal(mock.state.filter?.kind, 'eq')
    assert.equal(mock.inserted.length, 1)
  })

  it('reports a failed lookup distinctly instead of the no-such-account warning', async () => {
    const mock = makeSupabaseMock()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      mock.state.account = { id: 'broker-uuid', user_id: 'user-1' }
      mock.state.trade = { signal_id: 'sig-1' }
      mock.state.lookupError = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }
      registerOrderCloseAuditSupabase(mock.supabase as never)

      auditOrderClose({
        source: 'mtapi',
        // Distinct from every other accountId in this file: accountByFxAccount
        // is a process-lifetime cache, so a reused id would short-circuit the
        // lookup and make this test pass for the wrong reason.
        accountId: '7e1f4a2c-0b5d-4e8a-9c3f-1d2e3f4a5b6c',
        ticket: 3321526729,
        ok: true,
      })
      await flush()
      registerOrderCloseAuditSink(null)

      assert.equal(mock.inserted.length, 0)
      const line = warnings.find(w => w.includes('broker_account lookup failed'))
      assert.ok(line, `expected a distinct lookup-failed line, got: ${JSON.stringify(warnings)}`)
      assert.match(line, /code=PGRST116/)
      assert.equal(
        warnings.some(w => w.includes('skip persist — no broker_account')),
        false,
        'the misleading no-such-account warning must not also be emitted',
      )
    } finally {
      console.warn = originalWarn
    }
  })
})
