import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeBrokerTradeTicket, normalizeMtBrokerTicket } from './brokerTradeTicket'

describe('MT broker trade ticket validation', () => {
  it('rejects missing, blank, whitespace, malformed, non-finite, zero, and negative tickets', () => {
    for (const ticket of [null, undefined, '', ' ', ' 123', '123 ', 'NaN', 'Infinity', '1.5', '0', '-1', 0, -1, NaN, Infinity, 1.5]) {
      assert.equal(normalizeMtBrokerTicket(ticket), null, String(ticket))
    }
  })

  it('accepts positive safe integer tickets and canonicalizes digit strings', () => {
    assert.equal(normalizeMtBrokerTicket(123), '123')
    assert.equal(normalizeMtBrokerTicket('123'), '123')
    assert.equal(normalizeMtBrokerTicket('000123'), '123')
  })

  it('rejects numeric identifiers outside JavaScript safe-integer precision', () => {
    assert.equal(normalizeMtBrokerTicket('9007199254740992'), null)
  })
})

describe('provider-specific ticket formats', () => {
  it('applies positive numeric ticket rules to FxSocket and MTAPI', () => {
    assert.equal(normalizeBrokerTradeTicket('fxsocket', 'NaN'), null)
    assert.equal(normalizeBrokerTradeTicket('mtapi', 0), null)
    assert.equal(normalizeBrokerTradeTicket('mtapi', 42), '42')
    assert.equal(normalizeBrokerTradeTicket(null, 'NaN'), null)
  })

  it('preserves non-empty opaque provider identifiers', () => {
    assert.equal(normalizeBrokerTradeTicket('ctrader', 'deal-abc-01'), 'deal-abc-01')
    assert.equal(normalizeBrokerTradeTicket('binance', '  opaque-id  '), 'opaque-id')
    assert.equal(normalizeBrokerTradeTicket('ctrader', 123), null)
    assert.equal(normalizeBrokerTradeTicket('unknown', 'opaque-id'), null)
    assert.equal(normalizeBrokerTradeTicket('ctrader', 'bad' + String.fromCharCode(0) + 'id'), null)
  })
})
