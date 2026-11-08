import { describe, expect, it } from 'vitest'
import { brokerConnectErrorText, classifyBrokerConnectError, userFacingBrokerConnectError, type BrokerConnectErrorLabels } from './brokerConnectError'

const labels: BrokerConnectErrorLabels = {
  wrongPassword: 'PASSWORD',
  wrongLogin: 'LOGIN',
  wrongServer: 'SERVER',
  investorPassword: 'INVESTOR',
  accountDisabled: 'DISABLED',
  credentialsRejected: 'REJECTED',
  terminalNotReady: 'NOT_READY',
  sessionExpired: 'EXPIRED',
  rateLimited: 'RATE',
  unknown: 'UNKNOWN',
}

describe('worker "invalid login or password" text', () => {
  it('is classified as a wrong password, not a wrong login number', () => {
    expect(classifyBrokerConnectError('MTAPI connect failed: invalid login or password')).toBe('wrong_password')
    expect(userFacingBrokerConnectError('MTAPI connect failed: invalid login or password', labels)).toBe('PASSWORD')
  })

  it('still reports other messages as before', () => {
    expect(classifyBrokerConnectError('invalid login')).toBe('wrong_login')
    expect(brokerConnectErrorText(undefined, 'MTAPI connect failed: 503', labels)).toBe('MTAPI connect failed: 503')
  })
})
