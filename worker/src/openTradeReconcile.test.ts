import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { findGhostOpenTradeIds, reconcileOpenTradesForBroker, selectGhostClosures } from './openTradeReconcile'

const oldRequireHistory = process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY
afterEach(() => {
  if (oldRequireHistory == null) delete process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY
  else process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY = oldRequireHistory
})

describe('findGhostOpenTradeIds', () => {
  it('returns ids for tickets absent from broker', () => {
    const ghost = findGhostOpenTradeIds(
      [
        { id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' },
        { id: 'b', broker_account_id: 'b1', metaapi_order_id: '200' },
      ],
      new Set([200]),
    )
    assert.deepEqual(ghost, ['a'])
  })

  it('ignores rows without a valid ticket', () => {
    const ghost = findGhostOpenTradeIds(
      [
        { id: 'a', broker_account_id: 'b1', metaapi_order_id: null },
        { id: 'b', broker_account_id: 'b1', metaapi_order_id: '0' },
      ],
      new Set(),
    )
    assert.deepEqual(ghost, [])
  })

  it('returns empty when all tickets are on broker', () => {
    const ghost = findGhostOpenTradeIds(
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' }],
      new Set([100]),
    )
    assert.deepEqual(ghost, [])
  })
})

describe('reconcileOpenTradesForBroker', () => {
  it('does not mass-close when OpenedOrders is empty', async () => {
    const updates: unknown[] = []
    const supabase = {
      from(table: string) {
        assert.equal(table, 'trades')
        return {
          select() {
            return this
          },
          in() {
            return this
          },
          eq() {
            return this
          },
          update(payload: unknown) {
            updates.push(payload)
            return {
              in: () => ({
                eq: () => ({
                  select: async () => ({ data: [], error: null }),
                }),
              }),
            }
          },
        }
      },
    }
    const api = {
      openedOrders: async () => [],
    }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '100' }],
    )
    assert.equal(closed, 0)
    assert.equal(updates.length, 0)
  })


  it('does not falsely close after one non-empty identity-mismatch snapshot', async () => {
    let openedCalls = 0
    const api = {
      openedOrders: async () => {
        openedCalls += 1
        if (openedCalls === 1) return [{ ticket: 999, type: 0, symbol: 'GBPUSD' }]
        return [{ ticket: 100, type: 0, symbol: 'EURUSD', lots: 0.1, openPrice: 1.1 }]
      },
    }
    const supabase = {
      from() {
        throw new Error('DB must not be mutated when the second snapshot restores identity')
      },
    }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{
        id: 'a',
        broker_account_id: 'b1',
        metaapi_order_id: '100',
        symbol: 'EURUSD',
        direction: 'buy',
        lot_size: 0.1,
        entry_price: 1.1,
      }],
    )
    assert.equal(closed, 0)
    assert.equal(openedCalls, 2)
  })

  it('acts on an empty snapshot when the session answers its health check (flat, not disconnected)', async () => {
    // Regression guard for 2026-10-04: the last trade on an account could never
    // be reconciled, because closing it is what makes the account empty and an
    // empty answer used to be treated as "session probably gone".
    const updates: unknown[] = []
    const supabase = {
      from() {
        const query = {
          select() { return query },
          in() { return query },
          eq() { return query },
          update(payload: unknown) {
            updates.push(payload)
            return {
              in: () => ({
                eq: () => ({
                  select: async () => ({ data: [], error: null }),
                }),
              }),
            }
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: [{ id: 'a', signal_id: null, broker_account_id: 'b1' }],
              error: null,
            }).then(resolve)
          },
        }
        return query
      },
    }
    const api = {
      openedOrders: async () => [],
      // Positive close record corroborates the ghost close.
      orderHistory: async () => [{ ticket: 400406267, closePrice: 4160, closeTime: 1_760_000_000 }],
    }
    await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '400406267' }],
      async () => {},
    )
    // The close ran (one update attempted) rather than deferring.
    assert.equal(updates.length, 1)
    assert.equal((updates[0] as { status?: string }).status, 'closed')
  })

  it('does NOT close an empty-snapshot ghost that is not corroborated by history', async () => {
    const updates: unknown[] = []
    const supabase = {
      from() {
        return {
          select() { return this },
          in() { return this },
          eq() { return this },
          update(payload: unknown) {
            updates.push(payload)
            return { in: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }
          },
        }
      },
    }
    const api = {
      openedOrders: async () => [],
      orderHistory: async () => [], // no close record -> cannot corroborate
    }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '400406267' }],
      async () => {},
    )
    assert.equal(closed, 0)
    assert.equal(updates.length, 0, 'must not close without a corroborating close record')
  })

  it('closes without history only when the requirement is explicitly disabled', async () => {
    process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY = 'false'
    const updates: unknown[] = []
    const supabase = {
      from() {
        const query: Record<string, unknown> = {
          select() { return query },
          in() { return query },
          eq() { return query },
          update(payload: unknown) {
            updates.push(payload)
            return { in: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: [{ id: 'a', signal_id: null, broker_account_id: 'b1' }],
              error: null,
            }).then(resolve)
          },
        }
        return query
      },
    }
    const api = { openedOrders: async () => [] }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '400406267' }],
      async () => {},
    )
    assert.equal(updates.length, 1)
    assert.equal((updates[0] as { status?: string }).status, 'closed')
    assert.ok(closed >= 0)
  })

  it('still defers on an empty snapshot when the session does not answer', async () => {
    const supabase = {
      from() {
        throw new Error('DB must not be touched while the session is unhealthy')
      },
    }
    const api = { openedOrders: async () => [] }
    const closed = await reconcileOpenTradesForBroker(
      supabase as never,
      api as never,
      'acct',
      [{ id: 'a', broker_account_id: 'b1', metaapi_order_id: '400406267' }],
      async () => { throw new Error('disconnected') },
    )
    assert.equal(closed, 0)
  })

  it('logs why identity is ambiguous and defers instead of closing', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      const supabase = {
        from() {
          throw new Error('DB must not be mutated for an ambiguous trade')
        },
      }
      const api = {
        // The stored ticket (100) is gone from the broker, but two live
        // positions are identical on every attribute the matcher compares —
        // the shape that produced the undiagnosable production log line.
        openedOrders: async () => [
          { ticket: 500, type: 1, symbol: 'BTCUSDm', lots: 0.15, openPrice: 85600 },
          { ticket: 501, type: 1, symbol: 'BTCUSDm', lots: 0.15, openPrice: 85600.05 },
        ],
      }
      const closed = await reconcileOpenTradesForBroker(
        supabase as never,
        api as never,
        'acct',
        [{
          id: 'amb-1',
          broker_account_id: 'b1',
          metaapi_order_id: '100',
          symbol: 'BTCUSDm',
          direction: 'sell',
          lot_size: 0.15,
          entry_price: 85600,
        }],
      )
      assert.equal(closed, 0)
      const line = warnings.find(w => w.includes('identity ambiguous trade=amb-1'))
      assert.ok(line, `expected an identity ambiguous line, got: ${JSON.stringify(warnings)}`)
      assert.match(line, /reason="attributes match multiple live positions"/)
      assert.match(line, /pass=first/)
      assert.match(line, /ticket=100/)
      assert.match(line, /symbol=BTCUSDm/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('logs pass=second when identity only becomes ambiguous on the second snapshot', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      const supabase = {
        from() {
          throw new Error('DB must not be mutated for an ambiguous trade')
        },
      }
      let openedCalls = 0
      const api = {
        // First snapshot: the stored ticket is gone and nothing matches on
        // attributes, so the trade reaches the second pass. Second snapshot:
        // two indistinguishable positions appear, which is ambiguous there —
        // previously logged nowhere.
        openedOrders: async () => {
          openedCalls += 1
          if (openedCalls === 1) return [{ ticket: 999, type: 0, symbol: 'EURUSD' }]
          return [
            { ticket: 500, type: 1, symbol: 'BTCUSDm', lots: 0.15, openPrice: 85600 },
            { ticket: 501, type: 1, symbol: 'BTCUSDm', lots: 0.15, openPrice: 85600.05 },
          ]
        },
      }
      const closed = await reconcileOpenTradesForBroker(
        supabase as never,
        api as never,
        'acct',
        [{
          id: 'amb-second',
          broker_account_id: 'b1',
          metaapi_order_id: '100',
          symbol: 'BTCUSDm',
          direction: 'sell',
          lot_size: 0.15,
          entry_price: 85600,
        }],
      )
      assert.equal(closed, 0)
      assert.equal(openedCalls, 2)
      const line = warnings.find(w => w.includes('identity ambiguous trade=amb-second'))
      assert.ok(line, `expected a second-pass identity ambiguous line, got: ${JSON.stringify(warnings)}`)
      assert.match(line, /pass=second/)
      assert.match(line, /reason="attributes match multiple live positions"/)
    } finally {
      console.warn = originalWarn
    }
  })
})

describe('selectGhostClosures (B1: close only on a positive per-ticket close record)', () => {
  const candidate = (id: string, status = 'ambiguous', reason = 'attributes match multiple live positions') =>
    ({ trade: { id }, resolution: { status, reason } })

  it('closes an absent row when history holds a close record', () => {
    const r = selectGhostClosures({
      candidates: [candidate('t1')],
      closeProof: () => true,
      requireProof: true,
    })
    assert.deepEqual(r.ghostIds, ['t1'])
    assert.deepEqual(r.deferred, [])
  })

  it('defers an absent row with no close record (identical siblings case)', () => {
    const r = selectGhostClosures({
      candidates: [candidate('t1')],
      closeProof: () => false,
      requireProof: true,
    })
    assert.deepEqual(r.ghostIds, [])
    assert.deepEqual(r.deferred, [{ id: 't1', reason: 'attributes match multiple live positions' }])
  })

  it('legacy mode closes only clearly-missing rows, never attribute-ambiguous ones', () => {
    const r = selectGhostClosures({
      candidates: [candidate('t1'), candidate('t2', 'missing')],
      closeProof: () => false,
      requireProof: false,
    })
    assert.deepEqual(r.ghostIds, ['t2'])
    assert.equal(r.deferred.length, 1)
  })

  it('never closes a row whose ticket maps to several live positions, even with a close record', () => {
    const r = selectGhostClosures({
      candidates: [{
        trade: { id: 't1' },
        resolution: { status: 'ambiguous', reason: 'stored ticket maps to multiple live positions', identityMatch: true },
      }],
      closeProof: () => true,
      requireProof: true,
    })
    assert.deepEqual(r.ghostIds, [])
    assert.equal(r.deferred.length, 1)
  })

  it('reports a missing-ticket reason when the resolver found nothing', () => {
    const r = selectGhostClosures({
      candidates: [candidate('t9', 'missing')],
      closeProof: () => false,
      requireProof: true,
    })
    assert.equal(r.deferred[0]?.reason, 'stored ticket has no live position match')
  })
})

describe('reconcileOpenTradesForBroker (non-flat path, B1 close proof)', () => {
  function mockSupabase(
    loaded: Array<{ id: string; signal_id: string | null; broker_account_id: string | null }>,
    writes: Array<Record<string, unknown>>,
  ) {
    // Responds only to the two queries `closeStaleOpenTrades` needs: the row
    // load (selects signal_id) returns the rows; the close update returns the
    // ids it closed; any other query (ramp-pending purge) returns nothing.
    const builder: Record<string, unknown> = {
      _op: 'select',
      _ids: [] as string[],
      _wantRows: false,
      from() { return builder },
      select(columns?: string) {
        if (builder._op !== 'update') {
          builder._op = 'select'
          builder._wantRows = String(columns ?? '').includes('signal_id')
        }
        return builder
      },
      update(patch: Record<string, unknown>) { builder._op = 'update'; writes.push(patch); return builder },
      delete() { builder._op = 'delete'; return builder },
      in(_column: string, ids: string[]) { builder._ids = ids; return builder },
      eq() { return builder },
      is() { return builder },
      or() { return builder },
      order() { return builder },
      limit() { return builder },
      maybeSingle() { return { data: null, error: null } },
      then(resolve: (value: unknown) => unknown) {
        const data = builder._op === 'update'
          ? (builder._ids as string[]).map(id => ({ id }))
          : builder._wantRows
            ? loaded
            : []
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    return builder as never
  }

  const sibling = { ticket: 7002, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.61 }
  const closeRow = { ticket: 7001, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, closeTime: '2026-10-06T14:50:00', closePrice: 4149, profit: 12.5 }

  function apiWith(history: unknown[]) {
    return {
      openedOrders: async () => [sibling],
      orderHistory: async () => history,
    } as never
  }

  it('closes a gone leg when the captured position ticket has a close record (identical sibling present)', async () => {
    const writes: Array<Record<string, unknown>> = []
    const supabase = mockSupabase([{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1' }], writes)
    const closed = await reconcileOpenTradesForBroker(
      supabase,
      apiWith([closeRow]),
      'acct-1',
      [{
        id: 't1',
        signal_id: 'sig-1',
        broker_account_id: 'acct-1',
        metaapi_order_id: '5001',            // order ticket: not in history
        broker_position_ticket: '7001',      // captured position ticket: in history
        symbol: 'XAUUSD',
        direction: 'buy',
        lot_size: 0.05,
        entry_price: 4146.6,
      }],
      undefined,
      'mtapi',
    )
    assert.equal(closed, 1)
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.close_reason, 'position_gone')
  })

  it('defers when history holds no close record for the row', async () => {
    const writes: Array<Record<string, unknown>> = []
    const supabase = mockSupabase([{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1' }], writes)
    const closed = await reconcileOpenTradesForBroker(
      supabase,
      apiWith([]),
      'acct-1',
      [{
        id: 't1',
        signal_id: 'sig-1',
        broker_account_id: 'acct-1',
        metaapi_order_id: '5001',
        symbol: 'XAUUSD',
        direction: 'buy',
        lot_size: 0.05,
        entry_price: 4146.6,
      }],
      undefined,
      'mtapi',
    )
    assert.equal(closed, 0)
    assert.equal(writes.length, 0)
  })
})

describe('reconcileOpenTradesForBroker (login corroboration)', () => {
  function mockSupabase2(loaded: Array<{ id: string; signal_id: string | null; broker_account_id: string | null }>, writes: Array<Record<string, unknown>>) {
    const builder: Record<string, unknown> = {
      _op: 'select', _ids: [] as string[], _wantRows: false,
      from() { return builder },
      select(columns?: string) {
        if (builder._op !== 'update') { builder._op = 'select'; builder._wantRows = String(columns ?? '').includes('signal_id') }
        return builder
      },
      update(patch: Record<string, unknown>) { builder._op = 'update'; writes.push(patch); return builder },
      delete() { builder._op = 'delete'; return builder },
      in(_c: string, ids: string[]) { builder._ids = ids; return builder },
      eq() { return builder }, is() { return builder }, or() { return builder },
      order() { return builder }, limit() { return builder },
      maybeSingle() { return { data: null, error: null } },
      then(resolve: (v: unknown) => unknown) {
        const data = builder._op === 'update' ? (builder._ids as string[]).map(id => ({ id })) : builder._wantRows ? loaded : []
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    return builder as never
  }

  const position = (login: string) => ({
    ticket: 7002, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.61,
    dealInternalIn: { login },
  })
  const closeRow = { ticket: 7001, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, closeTime: '2026-10-07T10:33:00', closePrice: 4138, profit: 6 }
  const row = {
    id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1',
    metaapi_order_id: '5001', broker_position_ticket: '7001',
    symbol: 'XAUUSD', direction: 'buy', lot_size: 0.05, entry_price: 4146.6,
  }
  const api = (login: string) => ({ openedOrders: async () => [position(login)], orderHistory: async () => [closeRow] }) as never

  it('defers when the snapshot belongs to a different login (untrusted read)', async () => {
    const writes: Array<Record<string, unknown>> = []
    const closed = await reconcileOpenTradesForBroker(
      mockSupabase2([{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1' }], writes),
      api('99999999'),
      'acct-1',
      [row],
      undefined,
      'mtapi',
      '52992109',
    )
    assert.equal(closed, 0)
    assert.equal(writes.length, 0)
  })

  it('closes normally when the snapshot login matches', async () => {
    const writes: Array<Record<string, unknown>> = []
    const closed = await reconcileOpenTradesForBroker(
      mockSupabase2([{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1' }], writes),
      api('52992109'),
      'acct-1',
      [row],
      undefined,
      'mtapi',
      '52992109',
    )
    assert.equal(closed, 1)
    assert.equal(writes.length, 1)
  })
})

describe('reconcileOpenTradesForBroker (login corroboration applies to MTAPI only)', () => {
  it('ignores the login check for other providers', async () => {
    const writes: Array<Record<string, unknown>> = []
    const builder: Record<string, unknown> = {
      _op: 'select', _ids: [] as string[], _wantRows: false,
      from() { return builder },
      select(c?: string) { if (builder._op !== 'update') { builder._op = 'select'; builder._wantRows = String(c ?? '').includes('signal_id') } return builder },
      update(p: Record<string, unknown>) { builder._op = 'update'; writes.push(p); return builder },
      delete() { return builder },
      in(_c: string, ids: string[]) { builder._ids = ids; return builder },
      eq() { return builder }, is() { return builder }, or() { return builder },
      order() { return builder }, limit() { return builder },
      maybeSingle() { return { data: null, error: null } },
      then(resolve: (v: unknown) => unknown) {
        const data = builder._op === 'update' ? (builder._ids as string[]).map(id => ({ id })) : builder._wantRows ? [{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1' }] : []
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    const api = {
      openedOrders: async () => [{ ticket: 7002, orderType: 'Buy', state: 'Filled', symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.61, dealInternalIn: { login: '99999999' } }],
      // FxSocket closing deal shape: entry contains "out", order === 0, keyed by `position`.
      orderHistory: async () => [{ entry: 'out', order: 0, position: 7001, price: 4138, profit: 6 }],
    } as never
    const closed = await reconcileOpenTradesForBroker(
      builder as never,
      api,
      'acct-1',
      [{ id: 't1', signal_id: 'sig-1', broker_account_id: 'acct-1', metaapi_order_id: '5001', broker_position_ticket: '7001', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.05, entry_price: 4146.6 }],
      undefined,
      'fxsocket',
      '52992109',
    )
    assert.equal(closed, 1)
    assert.equal(writes.length, 1)
  })
})
