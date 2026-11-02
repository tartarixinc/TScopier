import { describe, expect, it } from 'vitest'
import {
  brokerCanReconnect,
  brokerConnectionStatusLabel,
  brokerEffectiveConnectionStatus,
  brokerConnectionBadgeVariant,
} from './brokerReconnect'

describe('brokerEffectiveConnectionStatus', () => {
  it('prefers connection_status error over fxsocket connected', () => {
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: 'connected',
      connection_status: 'error',
    })).toBe('error')
  })

  it('falls back to fxsocket_status when connection is connected', () => {
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: 'error',
      connection_status: 'connected',
    })).toBe('error')
  })
})

describe('brokerCanReconnect', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'

  it('shows reconnect when worker marked error but fxsocket still connected', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: uuid,
      fxsocket_status: 'connected',
      connection_status: 'error',
    })).toBe(true)
  })

  it('shows reconnect for disconnected fxsocket status', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: uuid,
      fxsocket_status: 'disconnected',
      connection_status: 'connected',
    })).toBe(true)
  })

  it('hides reconnect when fully connected', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: uuid,
      fxsocket_status: 'connected',
      connection_status: 'connected',
    })).toBe(false)
  })

  it('hides reconnect without fxsocket session', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: '',
      fxsocket_status: 'error',
      connection_status: 'error',
    })).toBe(false)
  })
})

describe('brokerConnectionBadgeVariant', () => {
  it('marks worker-only downs as error', () => {
    expect(brokerConnectionBadgeVariant({
      is_active: true,
      fxsocket_status: 'connected',
      connection_status: 'error',
    })).toBe('error')
  })

  it('shows Connected when the terminal is already healthy but the link flag is still pending', () => {
    const labels = {
      statusPaused: 'Paused',
      statusConnected: 'Connected',
      statusConnecting: 'Connecting',
      statusRecovering: 'Reconnecting',
      statusDisconnected: 'Disconnected',
    }
    expect(brokerConnectionStatusLabel({
      is_active: true,
      fxsocket_status: 'connecting',
      connection_status: 'pending',
      terminal_connected: true,
      trade_allowed: true,
    }, labels)).toBe('Connected')
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: null,
      connection_status: 'pending',
      provider: 'mtapi',
      mtapi_status: 'connected',
    })).toBe('connected')
  })
})

describe('brokerEffectiveConnectionStatus — MTAPI', () => {
  it('returns mtapi_status when provider=mtapi', () => {
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: null,
      connection_status: null,
      provider: 'mtapi',
      mtapi_status: 'connected',
    })).toBe('connected')
  })

  it('prefers connection_status error over mtapi_status', () => {
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: null,
      connection_status: 'error',
      provider: 'mtapi',
      mtapi_status: 'connected',
    })).toBe('error')
  })

  it('falls back to connection_status when mtapi_status is null', () => {
    expect(brokerEffectiveConnectionStatus({
      fxsocket_status: 'connected',
      connection_status: 'connected',
      provider: 'mtapi',
      mtapi_status: null,
    })).toBe('connected')
  })
})

describe('brokerCanReconnect — MTAPI', () => {
  it('shows reconnect for disconnected MTAPI session', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: null,
      fxsocket_status: null,
      connection_status: null,
      provider: 'mtapi',
      mtapi_session_id: 'sess_abc',
      mtapi_status: 'disconnected',
    })).toBe(true)
  })

  it('hides reconnect for connected MTAPI session', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: null,
      fxsocket_status: null,
      connection_status: null,
      provider: 'mtapi',
      mtapi_session_id: 'sess_abc',
      mtapi_status: 'connected',
    })).toBe(false)
  })

  it('shows reconnect for an MTAPI row with no session yet (it cannot copy)', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: null,
      fxsocket_status: null,
      connection_status: 'error',
      provider: 'mtapi',
      mtapi_session_id: null,
      mtapi_status: 'error',
    })).toBe(true)
  })

  it('shows reconnect for a row moved to MTAPI that has never connected', () => {
    // mtapi_session_id is not sent to the browser at all, and mtapi_status is
    // null until the first observation — this is the shape a freshly switched
    // account has, and it must still be promptable.
    expect(brokerCanReconnect({
      fxsocket_account_id: null,
      fxsocket_status: 'connected',
      connection_status: 'connected',
      provider: 'mtapi',
      mtapi_status: null,
    })).toBe(true)
  })

  it('hides reconnect while an MTAPI connect attempt is in flight', () => {
    expect(brokerCanReconnect({
      fxsocket_account_id: null,
      fxsocket_status: null,
      connection_status: 'pending',
      provider: 'mtapi',
      mtapi_status: 'connecting',
    })).toBe(false)
  })
})
