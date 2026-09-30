import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { availableRemoteBrokers, isExplicitlyUnavailableRemoteBroker } from './brokerRemoteAvailability'

const removedSession = {
  fxsocket_status: 'disconnected',
  connection_status: 'error',
  terminal_connected: false,
  trade_allowed: false,
}

describe('dormant-cleanup remote broker guard', () => {
  it('disconnected broker + pending partial leg => zero quote calls', () => {
    let quoteCalls = 0
    const brokers = availableRemoteBrokers([{ id: 'removed', ...removedSession }])
    for (const _broker of brokers) quoteCalls += 1
    assert.equal(quoteCalls, 0)
  })

  it('disconnected broker + DB open trade => zero reconcile calls / zero business-issue emission', () => {
    let reconcileCalls = 0
    let businessIssues = 0
    const brokers = availableRemoteBrokers([{ id: 'removed', ...removedSession }])
    for (const _broker of brokers) {
      reconcileCalls += 1
      businessIssues += 1
    }
    assert.equal(reconcileCalls, 0)
    assert.equal(businessIssues, 0)
  })

  it('connected healthy broker behavior remains available for remote operations', () => {
    const brokers = availableRemoteBrokers([{
      id: 'healthy',
      fxsocket_status: 'connected',
      connection_status: 'connected',
      terminal_connected: true,
      trade_allowed: true,
    }])
    assert.deepEqual(brokers.map(broker => broker.id), ['healthy'])
    assert.equal(isExplicitlyUnavailableRemoteBroker(brokers[0]), false)
  })
})
