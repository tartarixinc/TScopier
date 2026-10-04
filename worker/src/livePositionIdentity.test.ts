import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { normalizeOrderResponse } from './fxsocketClient'
import {
  persistCanonicalPositionTicket,
  resolveCanonicalOpenPosition,
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

  it('persists an authoritative replacement with a stale-ticket CAS', async () => {
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
      ['update', { metaapi_order_id: '303' }],
      ['id', 'trade-1'],
      ['status', 'open'],
      ['metaapi_order_id', '101'],
    ])
  })

  it('management partial_profit sends the resolved effectiveTicket', () => {
    const source = readFileSync(require.resolve('./tradeExecutor/managementExecutor'), 'utf8')
    assert.match(source, /else if \(action === 'partial_profit'\)[\s\S]*?orderClose\(uuid, \{ ticket: effectiveTicket, lots \}\)/)
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
