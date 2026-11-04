import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  brokerAccountHealthPatchFromMtStatus,
  brokerTerminalHealthLabel,
  brokerTerminalHealthPhase,
} from './brokerHealth'
import type { BrokerAccount } from '../types/database'

const labels = {
  statusHealthy: 'Healthy',
  statusUnhealthy: 'Unhealthy',
  statusHealthChecking: 'Checking…',
}

function broker(
  patch: Partial<BrokerAccount>,
): Pick<
  BrokerAccount,
  | 'is_active'
  | 'connection_status'
  | 'fxsocket_status'
  | 'terminal_connected'
  | 'trade_allowed'
  | 'live_terminal_health_phase'
> {
  return {
    is_active: true,
    connection_status: 'connected',
    fxsocket_status: 'connected',
    terminal_connected: null,
    trade_allowed: null,
    live_terminal_health_phase: null,
    ...patch,
  }
}

describe('brokerTerminalHealthPhase', () => {
  it('returns paused when copy trades is off', () => {
    assert.equal(brokerTerminalHealthPhase(broker({ is_active: false })), 'paused')
  })

  it('returns checking while linking', () => {
    assert.equal(brokerTerminalHealthPhase(broker({ connection_status: 'pending' })), 'checking')
    assert.equal(brokerTerminalHealthPhase(broker({ fxsocket_status: 'connecting' })), 'checking')
  })

  it('does not stay in checking once the terminal is healthy', () => {
    assert.equal(
      brokerTerminalHealthPhase(broker({
        connection_status: 'pending',
        fxsocket_status: 'connecting',
        terminal_connected: true,
        trade_allowed: true,
      })),
      'healthy',
    )
  })

  it('returns healthy when terminal is connected and trading allowed', () => {
    assert.equal(
      brokerTerminalHealthPhase(broker({ terminal_connected: true, trade_allowed: true })),
      'healthy',
    )
  })

  it('returns unhealthy when trade is not allowed', () => {
    assert.equal(
      brokerTerminalHealthPhase(broker({ terminal_connected: true, trade_allowed: false })),
      'unhealthy',
    )
  })

  it('returns checking when trade_allowed unknown', () => {
    assert.equal(
      brokerTerminalHealthPhase(broker({ terminal_connected: true, trade_allowed: null })),
      'checking',
    )
  })

  it('returns unhealthy when terminal is disconnected', () => {
    assert.equal(
      brokerTerminalHealthPhase(broker({ terminal_connected: false, trade_allowed: true })),
      'unhealthy',
    )
  })

  it('prefers live FxSocket health when available', () => {
    assert.equal(
      brokerTerminalHealthPhase(
        broker({
          terminal_connected: true,
          trade_allowed: true,
          live_terminal_health_phase: 'unhealthy',
        }),
      ),
      'unhealthy',
    )
  })
})

describe('brokerTerminalHealthLabel', () => {
  it('returns null for paused brokers', () => {
    assert.equal(brokerTerminalHealthLabel(broker({ is_active: false }), labels), null)
  })

  it('maps phases to labels', () => {
    assert.equal(
      brokerTerminalHealthLabel(broker({ terminal_connected: true, trade_allowed: true }), labels),
      'Healthy',
    )
    assert.equal(
      brokerTerminalHealthLabel(broker({ terminal_connected: false, trade_allowed: false }), labels),
      'Unhealthy',
    )
    assert.equal(brokerTerminalHealthLabel(broker({}), labels), 'Checking…')
  })
})

describe('brokerAccountHealthPatchFromMtStatus', () => {
  it('parses linked_account_type from status.account.type', () => {
    assert.equal(
      brokerAccountHealthPatchFromMtStatus({
        status: 'ready',
        account: { type: 'Demo', loggedIn: true },
      }).linked_account_type,
      'Demo',
    )
    assert.equal(
      brokerAccountHealthPatchFromMtStatus({
        status: 'ready',
        account: { type: 'Real', loggedIn: true },
      }).linked_account_type,
      'Live',
    )
  })

  it('omits linked_account_type when account type is missing', () => {
    assert.equal(
      brokerAccountHealthPatchFromMtStatus({ status: 'ready' }).linked_account_type,
      undefined,
    )
  })
})
