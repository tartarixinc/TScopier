import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { normalizeOrderResponse } from './fxsocketClient'
import {
  livePositionVolume,
  persistCanonicalPositionTicket,
  resolveCanonicalOpenPosition,
  resolveCurrentLivePosition,
  snapshotLogins,
} from './livePositionIdentity'

describe('MTAPI live identity normalization', () => {
  it('preserves MT5 order, deal, and position tickets and chooses the position for a market trade', () => {
    const result = normalizeOrderResponse(
      { order: 101, deal: 202, position: 303, state: 'Filled' },
      { platform: 'MT5', operation: 'Buy' },
    )
    assert.deepEqual(
      {
        ticket: result.ticket,
        orderTicket: result.orderTicket,
        dealTicket: result.dealTicket,
        positionTicket: result.positionTicket,
      },
      { ticket: 303, orderTicket: 101, dealTicket: 202, positionTicket: 303 },
    )
  })

  it('keeps the MT5 order ticket canonical while an order is pending', () => {
    const result = normalizeOrderResponse(
      { orderTicket: 101, dealTicket: 202, positionTicket: 303 },
      { platform: 'MT5', operation: 'BuyLimit' },
    )
    assert.equal(result.ticket, 101)
    assert.equal(result.positionTicket, 303)
  })
})

describe('broker live volume alias authority', () => {
  it('accepts each supported single-field shape', () => {
    assert.equal(livePositionVolume({ lots: 0.2 }), 0.2)
    assert.equal(livePositionVolume({ volume: 0.3 }), 0.3)
    assert.equal(livePositionVolume({ volumeCurrent: 0.4 }), 0.4)
  })

  it('accepts agreeing aliases', () => {
    assert.equal(livePositionVolume({ lots: 0.2, volume: 0.2, volumeCurrent: 0.2 }), 0.2)
  })

  it('fails closed when lot-denominated aliases conflict', () => {
    assert.equal(livePositionVolume({ lots: 0.3, volumeCurrent: 0.2 }), null)
    assert.equal(livePositionVolume({ lots: 0.3, lotSize: 0.2 }), null)
  })

  it('prefers lot fields over the unit-denominated `volume` alias', () => {
    assert.equal(livePositionVolume({ volume: 0.2, volumeCurrent: 0.1 }), 0.1)
    assert.equal(livePositionVolume({ lots: 0.3, volume: 0.2 }), 0.3)
  })

  it('reads the real MTAPI bridge row shape (lots + unit volume together)', () => {
    // Captured live 2026-10-07 from mtapi.tscopier.ai (account 62136328,
    // EURUSD): lots is in lots, volume is in contract units. The old
    // cross-alias conflict check returned null for this row, which made
    // attribute matching and manual partial closes fail closed on every
    // MTAPI position.
    const row = { lots: 0.01, volume: 1000000, contractSize: 100000, state: 'Filled' }
    assert.equal(livePositionVolume(row), 0.01)
  })

  it('ignores zero or invalid aliases when another positive alias is valid', () => {
    assert.equal(livePositionVolume({ lots: 0, volume: 'invalid', volumeCurrent: 0.1 }), 0.1)
  })
})
describe('canonical live position resolver', () => {
  const trade = {
    id: 'trade-1',
    metaapi_order_id: '101',
    symbol: 'EURUSD',
    direction: 'buy',
    lot_size: 0.2,
    entry_price: 1.1,
  }

  it('resolves a pending-order ticket to the resulting MT5 position ticket', () => {
    const result = resolveCanonicalOpenPosition({
      trade,
      openedOrders: [{
        type: 0,
        ticket: 303,
        orderTicket: 101,
        dealTicket: 202,
        positionTicket: 303,
        symbol: 'EURUSD',
        lots: 0.2,
        openPrice: 1.1,
      }],
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') {
      assert.equal(result.ticket, 303)
      assert.equal(result.replacement, true)
      assert.equal(result.matchedBy, 'explicit_relationship')
    }
  })

  it('ignores a stale pending row and cannot let its old ticket override the current position', () => {
    const result = resolveCanonicalOpenPosition({
      trade,
      openedOrders: [
        { type: 2, ticket: 101, operation: 'BuyLimit', symbol: 'EURUSD', lots: 0.2 },
        { type: 0, ticket: 303, orderTicket: 101, positionTicket: 303, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 },
      ],
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') assert.equal(result.ticket, 303)
  })

  it('fails closed when attributes match more than one position', () => {
    const result = resolveCanonicalOpenPosition({
      trade: { ...trade, metaapi_order_id: '999' },
      openedOrders: [
        { type: 0, ticket: 303, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 },
        { type: 0, ticket: 404, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 },
      ],
    })
    assert.equal(result.status, 'ambiguous')
  })

  it('persists an authoritative replacement into the position column with a stale-ticket CAS', async () => {
    const calls: Array<[string, unknown]> = []
    const query = {
      update(payload: unknown) { calls.push(['update', payload]); return this },
      eq(column: string, value: unknown) { calls.push([column, value]); return this },
      select() { return this },
      async maybeSingle() { return { data: { id: 'trade-1' }, error: null } },
    }
    const supabase = { from: () => query }
    const resolution = resolveCanonicalOpenPosition({
      trade,
      openedOrders: [{ type: 0, ticket: 303, orderTicket: 101, positionTicket: 303 }],
    })
    assert.equal(await persistCanonicalPositionTicket(supabase as never, trade, resolution), true)
    assert.deepEqual(calls, [
      ['update', { broker_position_ticket: '303', metaapi_order_id: '303' }],
      ['id', 'trade-1'],
      ['status', 'open'],
      ['metaapi_order_id', '101'],
    ])
  })

  it('CASes on the position column when the replacement came from a captured position ticket', async () => {
    const calls: Array<[string, unknown]> = []
    const query = {
      update(payload: unknown) { calls.push(['update', payload]); return this },
      eq(column: string, value: unknown) { calls.push([column, value]); return this },
      select() { return this },
      async maybeSingle() { return { data: { id: 'trade-1' }, error: null } },
    }
    const supabase = { from: () => query }
    const capturedTrade = { ...trade, broker_position_ticket: '101' }
    const resolution = resolveCanonicalOpenPosition({
      trade: capturedTrade,
      openedOrders: [{ type: 0, ticket: 303, orderTicket: 101, positionTicket: 303 }],
    })
    assert.equal(await persistCanonicalPositionTicket(supabase as never, capturedTrade, resolution), true)
    assert.deepEqual(calls, [
      ['update', { broker_position_ticket: '303', metaapi_order_id: '303' }],
      ['id', 'trade-1'],
      ['status', 'open'],
      ['broker_position_ticket', '101'],
    ])
  })

  it('falls back to metaapi_order_id when the position column is missing', async () => {
    const updates: Array<Record<string, unknown>> = []
    let attempt = 0
    const query = {
      update(payload: Record<string, unknown>) { updates.push(payload); return this },
      eq() { return this },
      select() { return this },
      async maybeSingle() {
        attempt += 1
        if (attempt === 1) {
          return { data: null, error: { code: 'PGRST204', message: "Could not find the 'broker_position_ticket' column of 'trades' in the schema cache" } }
        }
        return { data: { id: 'trade-1' }, error: null }
      },
    }
    const supabase = { from: () => query }
    const resolution = resolveCanonicalOpenPosition({
      trade,
      openedOrders: [{ type: 0, ticket: 303, orderTicket: 101, positionTicket: 303 }],
    })
    assert.equal(await persistCanonicalPositionTicket(supabase as never, trade, resolution), true)
    assert.deepEqual(updates, [
      { broker_position_ticket: '303', metaapi_order_id: '303' },
      { metaapi_order_id: '303' },
    ])
  })

  it('management partial_profit sends the resolved effectiveTicket', () => {
    const source = readFileSync(require.resolve('./tradeExecutor/managementExecutor'), 'utf8')
    assert.match(
      source,
      /else if \(action === 'partial_profit'\)[\s\S]*?orderClose\(uuid, \{ ticket: effectiveTicket, lots: plan\.closeVolume \}\)/,
    )
  })
})

describe('MTAPI bridge rows in open-trade reconcile', () => {
  // Regression guard for the false-close of 2026-10-04: these rows carry no
  // `operation` field, so the position filter rejected them, reconcile saw no
  // live positions and marked every tracked trade closed while it was open.
  it('resolves a filled MT5 row by its stored ticket', () => {
    const result = resolveCanonicalOpenPosition({
      trade: {
        id: 'trade-mtapi',
        metaapi_order_id: '3316111495',
        symbol: 'XAUUSDm',
        direction: 'buy',
        lot_size: 0.01,
        entry_price: 4179.911,
      },
      openedOrders: [{
        ticket: 3316111495,
        orderType: 'Buy',
        dealType: 'DealBuy',
        state: 'Filled',
        symbol: 'XAUUSDm',
        lots: 0.01,
        openPrice: 4179.911,
      }],
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') {
      assert.equal(result.matchedBy, 'canonical_ticket')
      assert.equal(result.ticket, 3316111495)
    }
  })

  it('falls back to attributes when the stored ticket no longer matches', () => {
    const result = resolveCanonicalOpenPosition({
      trade: {
        id: 'trade-mtapi-2',
        metaapi_order_id: '999999',
        symbol: 'XAUUSDm',
        direction: 'buy',
        lot_size: 0.01,
        entry_price: 4179.911,
      },
      openedOrders: [{
        ticket: 555,
        orderType: 'Buy',
        state: 'Filled',
        symbol: 'XAUUSDm',
        lots: 0.01,
        openPrice: 4179.911,
      }],
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') assert.equal(result.matchedBy, 'attributes')
  })
})

describe('broker_position_ticket preference', () => {
  const positions = [{
    ticket: 7001,
    orderTicket: 5001,
    orderType: 'Buy',
    state: 'Filled',
    symbol: 'XAUUSD',
    lots: 0.05,
    openPrice: 4146.6,
  }]

  it('prefers the captured position ticket over the stored order ticket', () => {
    const result = resolveCanonicalOpenPosition({
      trade: {
        id: 'trade-pos',
        metaapi_order_id: '5001',          // order ticket, matches the row's orderTicket
        broker_position_ticket: '7001',    // captured position ticket
        symbol: 'XAUUSD',
        direction: 'buy',
        lot_size: 0.05,
        entry_price: 4146.6,
      },
      openedOrders: positions,
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') {
      assert.equal(result.ticket, 7001)
      assert.equal(result.matchedBy, 'canonical_ticket')
    }
  })

  it('falls back to metaapi_order_id when no position ticket was captured', () => {
    const result = resolveCanonicalOpenPosition({
      trade: {
        id: 'trade-no-pos',
        metaapi_order_id: '5001',
        symbol: 'XAUUSD',
        direction: 'buy',
        lot_size: 0.05,
        entry_price: 4146.6,
      },
      openedOrders: positions,
    })
    assert.equal(result.status, 'resolved')
    if (result.status === 'resolved') assert.equal(result.ticket, 7001)
  })
})

describe('attribute-only matches never persist or act', () => {
  const attrTrade = {
    id: 'trade-attr',
    metaapi_order_id: '999999',
    symbol: 'XAUUSD',
    direction: 'buy',
    lot_size: 0.05,
    entry_price: 4146.6,
  }
  const rows = [{ type: 0, ticket: 7001, symbol: 'XAUUSD', lots: 0.05, openPrice: 4146.6 }]

  it('persistCanonicalPositionTicket refuses an attribute-only replacement', async () => {
    const calls: unknown[] = []
    const query = {
      update(payload: unknown) { calls.push(payload); return this },
      eq() { return this },
      select() { return this },
      async maybeSingle() { return { data: { id: 'trade-attr' }, error: null } },
    }
    const supabase = { from: () => query }
    const resolution = resolveCanonicalOpenPosition({ trade: attrTrade, openedOrders: rows })
    assert.equal(resolution.status, 'resolved')
    if (resolution.status === 'resolved') assert.equal(resolution.matchedBy, 'attributes')
    assert.equal(await persistCanonicalPositionTicket(supabase as never, attrTrade, resolution), false)
    assert.equal(calls.length, 0)
  })

  it('resolveCurrentLivePosition fails closed for an attribute-only match', async () => {
    const api = { openedOrders: async () => rows }
    const res = await resolveCurrentLivePosition({
      supabase: {} as never,
      api: api as never,
      sessionId: 'session-1',
      trade: attrTrade,
    })
    assert.equal(res.status, 'ambiguous')
    if (res.status === 'ambiguous') assert.match(res.reason, /attributes/)
  })
})

describe('snapshotLogins', () => {
  it('reads the login from nested deal objects and plain rows', () => {
    const logins = snapshotLogins([
      { ticket: 1, dealInternalIn: { login: 52992109 } },
      { ticket: 2, login: '111222' },
      { ticket: 3, dealInternalOut: { login: '52992109' } },
      { ticket: 4 },
    ])
    assert.deepEqual([...logins].sort(), ['111222', '52992109'])
  })

  it('returns nothing for an empty or non-array snapshot', () => {
    assert.equal(snapshotLogins([]).size, 0)
  })
})

describe('persistCanonicalPositionTicket: verified-caller opt-in', () => {
  const attrTrade = {
    id: 'trade-verified',
    metaapi_order_id: '1001',
    symbol: 'XAUUSD',
    direction: 'buy',
    lot_size: 0.01,
    entry_price: 4146.6,
  }
  const postClose = [{ type: 0, ticket: 2002, symbol: 'XAUUSD', lots: 0.01, openPrice: 4146.6 }]

  it('refuses an attribute-only replacement by default', async () => {
    const calls: unknown[] = []
    const query = {
      update(p: unknown) { calls.push(p); return this },
      eq() { return this }, is() { return this }, select() { return this },
      async maybeSingle() { return { data: { id: 'trade-verified' }, error: null } },
    }
    const resolution = resolveCanonicalOpenPosition({ trade: attrTrade, openedOrders: postClose })
    assert.equal(await persistCanonicalPositionTicket({ from: () => query } as never, attrTrade, resolution), false)
    assert.equal(calls.length, 0)
  })

  it('persists when the caller has verified the relationship', async () => {
    const updates: Array<Record<string, unknown>> = []
    const query = {
      update(p: Record<string, unknown>) { updates.push(p); return this },
      eq() { return this }, is() { return this }, select() { return this },
      async maybeSingle() { return { data: { id: 'trade-verified' }, error: null } },
    }
    const resolution = resolveCanonicalOpenPosition({ trade: attrTrade, openedOrders: postClose })
    const ok = await persistCanonicalPositionTicket(
      { from: () => query } as never,
      attrTrade,
      resolution,
      { allowAttributeMatch: true },
    )
    assert.equal(ok, true)
    assert.deepEqual(updates, [{ broker_position_ticket: '2002', metaapi_order_id: '2002' }])
  })
})
