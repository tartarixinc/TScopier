import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideBrokerPendingClosedFill,
  decideBrokerPendingOpenedState,
  resolveFilledPositionTicket,
} from './brokerPendingFillDetect'
import { rawOrderTicket } from './signalEntryPendingHelpers'

const leg = {
  signal_id: '4d999b3e-4f40-46ac-9c3f-3c41c04384b6',
  symbol: 'XAUUSD',
  ticket: '1001',
  comment: 'TSc:4d999b3e:rg2.tp1',
  trigger_price: 4055,
  volume: 0.12,
}

describe('brokerPendingFillDetect', () => {
  it('still_pending when original limit ticket is resting', () => {
    const opened = [
      { ticket: 1001, operation: 'SellLimit', symbol: 'XAUUSD', comment: leg.comment, price: 4055 },
    ]
    assert.equal(decideBrokerPendingOpenedState(opened, leg).kind, 'still_pending')
  })

  it('filled by same ticket when pending converted in place', () => {
    const opened = [
      { ticket: 1001, operation: 'Sell', symbol: 'XAUUSD', comment: leg.comment, openPrice: 4055.2, lots: 0.12 },
    ]
    const d = decideBrokerPendingOpenedState(opened, leg)
    assert.equal(d.kind, 'filled')
    if (d.kind !== 'filled') return
    assert.equal(d.hit.matchedBy, 'same_ticket')
    assert.equal(d.hit.positionTicket, '1001')
    assert.equal(d.hit.fillPrice, 4055.2)
  })

  it('filled by comment when MT5 changes ticket and ClosedOrders is empty', () => {
    const opened = [
      // Immediate market leg already open — must not steal this fill.
      { ticket: 2000, operation: 'Sell', symbol: 'XAUUSD', comment: 'TSc:4d999b3e:tp1', openPrice: 4061.7, lots: 0.12 },
      // Filled limit with new ticket + unique comment.
      { ticket: 3003, operation: 'Sell', symbol: 'XAUUSD', comment: leg.comment, openPrice: 4055.1, lots: 0.12 },
    ]
    const d = decideBrokerPendingOpenedState(opened, leg, new Set(['2000']))
    assert.equal(d.kind, 'filled')
    if (d.kind !== 'filled') return
    assert.equal(d.hit.matchedBy, 'comment')
    assert.equal(d.hit.positionTicket, '3003')
    assert.equal(d.hit.fillPrice, 4055.1)
  })

  it('does not match unrelated immediate legs via signal needle alone', () => {
    const opened = [
      { ticket: 2000, operation: 'Sell', symbol: 'XAUUSD', comment: 'TSc:4d999b3e:tp1', openPrice: 4061.7, lots: 0.12 },
    ]
    const d = decideBrokerPendingOpenedState(opened, leg, new Set(['2000']))
    assert.equal(d.kind, 'absent')
  })

  it('closed_ticket path resolves new position from OpenedOrders', () => {
    const opened = [
      { ticket: 3003, operation: 'Sell', symbol: 'XAUUSD', comment: leg.comment, openPrice: 4055.1, lots: 0.12 },
    ]
    const closed = [{ ticket: 1001, openPrice: 4055.05 }]
    const hit = decideBrokerPendingClosedFill(opened, closed, leg)
    assert.ok(hit)
    assert.equal(hit!.positionTicket, '3003')
    assert.equal(hit!.fillPrice, 4055.1)
  })

  it('resolveFilledPositionTicket scores comment over loose signal match', () => {
    const opened = [
      { ticket: 2000, operation: 'Sell', symbol: 'XAUUSD', comment: 'TSc:4d999b3e:tp1', openPrice: 4055.0, lots: 0.12 },
      { ticket: 3003, operation: 'Sell', symbol: 'XAUUSD', comment: leg.comment, openPrice: 4055.2, lots: 0.12 },
    ]
    const r = resolveFilledPositionTicket(opened, leg, 1001)
    assert.equal(r.matchedBy, 'comment')
    assert.equal(r.ticket, '3003')
  })
})
it('raw MT broker ticket parsing rejects malformed and non-positive identifiers', () => {
  for (const ticket of ['', ' ', 'NaN', 'Infinity', '1.5', '0', '-1', NaN, Infinity, 1.5]) {
    assert.equal(rawOrderTicket({ ticket }), 0, String(ticket))
  }
  assert.equal(rawOrderTicket({ ticket: '123' }), 123)
})
