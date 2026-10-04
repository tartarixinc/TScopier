import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isBrokerDownDemo } from './demoOutage'

describe('isBrokerDownDemo', () => {
  it('is off without a query string', () => {
    assert.equal(isBrokerDownDemo(''), false)
    assert.equal(isBrokerDownDemo('?'), false)
  })

  it('is on only for the exact demo value', () => {
    assert.equal(isBrokerDownDemo('?demo=broker-down'), true)
    assert.equal(isBrokerDownDemo('?demo=broker-down&tab=open'), true)
    assert.equal(isBrokerDownDemo('?tab=open&demo=broker-down'), true)
    assert.equal(isBrokerDownDemo('?demo=something-else'), false)
    assert.equal(isBrokerDownDemo('?demo='), false)
  })

  it('ignores other parameter spellings', () => {
    assert.equal(isBrokerDownDemo('?Demo=broker-down'), false)
    assert.equal(isBrokerDownDemo('?demo2=broker-down'), false)
    assert.equal(isBrokerDownDemo('?xdemo=broker-down&demo=broker-down'), true)
  })

  it('never throws on odd input', () => {
    assert.equal(isBrokerDownDemo('?%'), false)
    assert.equal(isBrokerDownDemo('demo=broker-down'), true, 'URLSearchParams accepts a bare query string')
    assert.equal(isBrokerDownDemo('%%%'), false)
  })
})
