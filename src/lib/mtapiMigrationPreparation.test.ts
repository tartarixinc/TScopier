import { describe, expect, it, vi } from 'vitest'
import {
  prepareExistingBrokerForMtapi,
  type MtapiMigrationPreparationRequest,
} from './fxsocketBroker'

describe('prepareExistingBrokerForMtapi', () => {
  it('calls the same-row preparation action without changing provider or exposing secrets', async () => {
    const invoke = vi.fn(async (request: MtapiMigrationPreparationRequest) => ({
      prepared: true,
      account: {
        id: request.body.broker_account_id,
        provider: 'fxsocket',
        fxsocket_account_id: 'fxsocket-1',
        mtapi_session_id: 'server-only-session',
        broker_password_encrypted: 'v1:server-only',
      },
      summary: { balance: 1000 },
    }))

    const result = await prepareExistingBrokerForMtapi({
      account: { id: 'broker-1', provider: 'fxsocket' },
      accountPassword: ' password with spaces ',
      timeoutMs: 12_345,
    }, invoke)

    expect(invoke).toHaveBeenCalledWith({
      edgeFn: 'mtapi-broker',
      timeoutMs: 12_345,
      body: {
        action: 'prepare_migration',
        broker_account_id: 'broker-1',
        account_password: ' password with spaces ',
      },
    })
    expect(result.prepared).toBe(true)
    expect(result.account.id).toBe('broker-1')
    expect(result.account.provider).toBe('fxsocket')
    expect(result.account.fxsocket_account_id).toBe('fxsocket-1')
    expect(result.account).not.toHaveProperty('mtapi_session_id')
    expect(result.account).not.toHaveProperty('broker_password_encrypted')
    expect(result.summary?.balance).toBe(1000)
  })

  it('rejects non-FXSocket accounts without calling the API', async () => {
    const invoke = vi.fn()
    await expect(prepareExistingBrokerForMtapi({
      account: { id: 'broker-1', provider: 'mtapi' },
      accountPassword: 'secret',
    }, invoke)).rejects.toThrow('Only an FXSocket broker account')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects blank passwords without calling the API', async () => {
    const invoke = vi.fn()
    await expect(prepareExistingBrokerForMtapi({
      account: { id: 'broker-1', provider: 'fxsocket' },
      accountPassword: '   ',
    }, invoke)).rejects.toThrow('Broker password is required')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('fails closed if the server response activates MTAPI', async () => {
    const invoke = vi.fn(async () => ({
      prepared: true,
      account: {
        id: 'broker-1',
        provider: 'mtapi',
        mtapi_session_id: 'must-not-leak',
      },
    }))
    await expect(prepareExistingBrokerForMtapi({
      account: { id: 'broker-1', provider: 'fxsocket' },
      accountPassword: 'secret',
    }, invoke)).rejects.toThrow('must not activate the provider')
  })

  it('requires an explicit prepared response with an account', async () => {
    const invoke = vi.fn(async () => ({ prepared: false }))
    await expect(prepareExistingBrokerForMtapi({
      account: { id: 'broker-1', provider: 'fxsocket' },
      accountPassword: 'secret',
    }, invoke)).rejects.toThrow('did not return an account')
  })
})
