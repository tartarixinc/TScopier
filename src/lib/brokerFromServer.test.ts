import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  inferPropFirmAccount,
  resolveLinkedAccountType,
  resolveLinkedAccountTypeForBroker,
} from './brokerFromServer'

describe('resolveLinkedAccountType', () => {
  it('detects prop firms from server hostname', () => {
    assert.equal(resolveLinkedAccountType(undefined, 'FTMO-Server'), 'PropFirm')
    assert.equal(resolveLinkedAccountType(undefined, 'FundedNext-Server'), 'PropFirm')
    assert.equal(resolveLinkedAccountType('2', 'FTMO-Server'), 'PropFirm')
    assert.equal(resolveLinkedAccountTypeForBroker({
      broker_name: null,
      broker_server: 'Upcomers-Server',
      metaapi_account_id: 'uuid',
    }), 'PropFirm')
  })

  it('detects prop firms from broker label hint', () => {
    assert.equal(resolveLinkedAccountType(undefined, 'SomeHost', 'FTMO'), 'PropFirm')
  })

  it('still classifies retail demo and live servers', () => {
    assert.equal(resolveLinkedAccountType('0', 'ICMarkets-Demo'), 'Demo')
    assert.equal(resolveLinkedAccountType('2', 'ICMarkets-Live'), 'Live')
    assert.equal(resolveLinkedAccountType(undefined, 'Pepperstone-Live'), 'Live')
  })

  it('returns undefined when nothing matches', () => {
    assert.equal(resolveLinkedAccountType(undefined, 'UnknownBroker-Server'), undefined)
  })
})

describe('inferPropFirmAccount', () => {
  it('matches common prop firm brands', () => {
    assert.equal(inferPropFirmAccount('FivePercentOnline-Real'), true)
    assert.equal(inferPropFirmAccount('E8Markets-Live'), true)
    assert.equal(inferPropFirmAccount('FundingPips-Server'), true)
    assert.equal(inferPropFirmAccount('Upcomers-Server'), true)
  })

  it('does not match retail brokers', () => {
    assert.equal(inferPropFirmAccount('ICMarkets-Live'), false)
    assert.equal(inferPropFirmAccount('Pepperstone-Demo'), false)
  })
})
