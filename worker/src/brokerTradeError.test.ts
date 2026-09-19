import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROKER_SYMBOL_NOT_FOUND,
  SIGNAL_MISSING_REQUIRED_SL,
  formatFxHttpFailureMessage,
  humanizeOrderSendError,
  isStopLossWithheldByProvider,
  parseFxErrorEnvelope,
  tradeFailureReasonFromBrokerMessage,
  tradeFailureReasonFromCode,
} from './brokerTradeError'

describe('parseFxErrorEnvelope', () => {
  it('reads message + MRPC code from FxSocket body', () => {
    const env = parseFxErrorEnvelope({
      error: 'MRPC',
      message: 'SymbolSelect failed',
      command_id: 9831,
    })
    assert.equal(env.message, 'SymbolSelect failed')
    assert.equal(env.code, 'MRPC')
  })
})

describe('formatFxHttpFailureMessage', () => {
  it('maps SymbolSelect failed + OrderSend symbol to Symbol not found', () => {
    const msg = formatFxHttpFailureMessage({
      status: 500,
      body: { error: 'MRPC', message: 'SymbolSelect failed', command_id: 1 },
      requestBody: { symbol: 'XAUUSD', operation: 'Sell', volume: 0.01 },
    })
    assert.equal(msg, 'Symbol not found: XAUUSD')
  })

  it('maps SymbolSelect failed from getQuote URL symbol', () => {
    const msg = formatFxHttpFailureMessage({
      status: 500,
      body: { error: 'MRPC', message: 'SymbolSelect failed' },
      url: 'https://api.fxsocket.com/mt5/acct/getQuote?symbol=XAUUSD',
    })
    assert.equal(msg, 'Symbol not found: XAUUSD')
  })

  it('does not leave bare HTTP 500 when body is empty', () => {
    const msg = formatFxHttpFailureMessage({ status: 500, body: null })
    assert.match(msg, /Broker rejected this order/i)
    assert.doesNotMatch(msg, /^HTTP 500$/)
  })
})

describe('isStopLossWithheldByProvider', () => {
  it('recognizes premium/VIP stop-loss wording', () => {
    assert.equal(isStopLossWithheldByProvider('GOLD BUY TP 2400 SL premium'), true)
    assert.equal(isStopLossWithheldByProvider('XAUUSD buy\nSL for premium members\nTP 2440'), true)
    assert.equal(isStopLossWithheldByProvider('subscribe for SL details'), true)
    assert.equal(isStopLossWithheldByProvider('VIP stop loss available after payment'), true)
  })

  it('does not treat numeric SL or generic premium wording as withheld SL', () => {
    assert.equal(isStopLossWithheldByProvider('GOLD BUY SL 2290 TP 2400'), false)
    assert.equal(isStopLossWithheldByProvider('Premium signal GOLD BUY TP 2400'), false)
  })
})

describe('tradeFailureReasonFromCode', () => {
  it('builds structured missing-SL copy without inventing a stop loss', () => {
    const reason = tradeFailureReasonFromCode(SIGNAL_MISSING_REQUIRED_SL, {
      missingField: 'stop_loss',
      withheldByProvider: true,
    })
    assert.equal(reason?.reasonCode, SIGNAL_MISSING_REQUIRED_SL)
    assert.equal(reason?.category, 'signal')
    assert.equal(reason?.retryable, false)
    assert.equal(reason?.userActionRequired, true)
    assert.match(reason?.title ?? '', /SL not given/i)
    assert.match(reason?.title ?? '', /predefined SL pips/i)
    assert.match(reason?.explanation ?? '', /premium\/VIP subscribers/i)
    assert.match(reason?.explanation ?? '', /Override signal SL/i)
    assert.doesNotMatch(reason?.explanation ?? '', /\b\d+(?:\.\d+)?\b/)
  })

  it('maps TP-without-SL to the same predefined-SL hint after uppercase lookup', () => {
    const reason = tradeFailureReasonFromCode('entry_tp_without_sl', {
      missingField: 'stop_loss',
    })
    assert.equal(reason?.reasonCode, 'ENTRY_TP_WITHOUT_SL')
    assert.match(reason?.title ?? '', /SL not given/i)
    assert.match(reason?.title ?? '', /predefined SL pips/i)
    assert.match(reason?.explanation ?? '', /take-profit/i)
    assert.match(reason?.recommendedAction ?? '', /Override signal SL/i)
  })

  it('maps legacy SYMBOL_UNSUPPORTED to the broker-symbol user contract', () => {
    const reason = tradeFailureReasonFromCode('SYMBOL_UNSUPPORTED', {
      requestedSymbol: 'XAUUSD',
    })
    assert.equal(reason?.reasonCode, BROKER_SYMBOL_NOT_FOUND)
    assert.match(reason?.explanation ?? '', /GOLD\/XAUUSD/)
    assert.equal(reason?.retryable, false)
  })

  it('classifies INVALID_REQUEST as a broker rejection with actionable guidance', () => {
    const reason = tradeFailureReasonFromCode('INVALID_REQUEST', {
      requestedSymbol: 'XAUUSD',
    })
    assert.equal(reason?.reasonCode, 'INVALID_REQUEST')
    assert.equal(reason?.category, 'broker')
    assert.equal(reason?.retryable, false)
    assert.equal(reason?.userActionRequired, true)
    assert.match(reason?.title ?? '', /Invalid request/i)
    assert.match(reason?.explanation ?? '', /symbol is not available|order parameters|position was already closed/i)
    assert.match(reason?.recommendedAction ?? '', /symbol.*enabled|lot size|symbol mapping/i)
  })
})

describe('tradeFailureReasonFromBrokerMessage', () => {
  it('maps known broker messages into deterministic reasons', () => {
    assert.equal(
      tradeFailureReasonFromBrokerMessage('SymbolSelect failed', { requestedSymbol: 'XAUUSD' })?.reasonCode,
      BROKER_SYMBOL_NOT_FOUND,
    )
    assert.equal(
      tradeFailureReasonFromBrokerMessage('not enough money')?.reasonCode,
      'INSUFFICIENT_MARGIN',
    )
    assert.equal(
      tradeFailureReasonFromBrokerMessage('market closed')?.reasonCode,
      'MARKET_CLOSED',
    )
    assert.equal(
      tradeFailureReasonFromBrokerMessage('invalid volume')?.reasonCode,
      'INVALID_LOT',
    )
  })

  it('maps "Invalid request" to INVALID_REQUEST', () => {
    assert.equal(
      tradeFailureReasonFromBrokerMessage('Invalid request')?.reasonCode,
      'INVALID_REQUEST',
    )
    assert.equal(
      tradeFailureReasonFromBrokerMessage('MT4 error 4108: Invalid request')?.reasonCode,
      'INVALID_REQUEST',
    )
  })
})

describe('humanizeOrderSendError', () => {
  it('upgrades historical HTTP 500 with symbol', () => {
    assert.equal(
      humanizeOrderSendError('HTTP 500', 'XAUUSD'),
      'Broker rejected the order for XAUUSD. Check symbol mapping and try again.',
    )
  })

  it('normalizes SymbolSelect failed', () => {
    assert.equal(humanizeOrderSendError('SymbolSelect failed', 'gold#'), 'Symbol not found: GOLD#')
  })

  it('maps "Invalid request" to a descriptive message', () => {
    assert.equal(
      humanizeOrderSendError('Invalid request'),
      'Broker rejected order: invalid request. Check symbol availability and order parameters.',
    )
  })
})
