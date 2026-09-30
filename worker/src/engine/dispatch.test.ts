import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifySignal, isDesiredStateOnly, isEntry } from './dispatch'
import { isV2, resolveExecutionEngine, splitBrokersByEngine } from './executionMode'

describe('classifySignal', () => {
  it('routes buy/sell as entries', () => {
    assert.equal(classifySignal('buy'), 'entry')
    assert.equal(classifySignal('SELL'), 'entry')
    assert.equal(classifySignal('buy', true), 'entry')
  })
  it('routes management actions', () => {
    assert.equal(classifySignal('modify'), 'modify')
    assert.equal(classifySignal('close'), 'close')
    assert.equal(classifySignal('breakeven'), 'breakeven')
    assert.equal(classifySignal('partial_profit'), 'partial')
  })
  it('ignores unknown actions', () => {
    assert.equal(classifySignal('chitchat'), 'ignore')
    assert.equal(classifySignal(null), 'ignore')
  })
  it('management lanes are desired-state-only (never touch broker directly)', () => {
    assert.equal(isDesiredStateOnly(classifySignal('modify')), true)
    assert.equal(isDesiredStateOnly(classifySignal('breakeven')), true)
    assert.equal(isEntry(classifySignal('buy')), true)
    assert.equal(isDesiredStateOnly(classifySignal('buy')), false)
  })
})

describe('resolveExecutionEngine (cutover flag)', () => {
  it('defaults to v1', () => {
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b', userId: 'u' }, {}), 'v1')
  })
  it('global switch EXECUTION_ENGINE=v2', () => {
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b' }, { EXECUTION_ENGINE: 'v2' }), 'v2')
  })
  it('per-broker allowlist', () => {
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b1' }, { EXECUTION_ENGINE_V2_BROKERS: 'b1,b2' }), 'v2')
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b9' }, { EXECUTION_ENGINE_V2_BROKERS: 'b1,b2' }), 'v1')
  })
  it('per-user allowlist', () => {
    assert.equal(resolveExecutionEngine({ userId: 'u1' }, { EXECUTION_ENGINE_V2_USERS: 'u1' }), 'v2')
  })
  it('MTAPI provider bypasses EXECUTION_ENGINE and stays on v1', () => {
    assert.equal(
      resolveExecutionEngine({ brokerAccountId: 'b1', userId: 'u1', provider: 'mtapi' }, { EXECUTION_ENGINE: 'v2' }),
      'v1',
    )
    assert.equal(
      resolveExecutionEngine({ brokerAccountId: 'b1', provider: 'mtapi' }, { EXECUTION_ENGINE_V2_BROKERS: 'b1' }),
      'v1',
    )
    assert.equal(
      isV2({ brokerAccountId: 'b1', userId: 'u1', provider: 'mtapi' }, { EXECUTION_ENGINE: 'v2' }),
      false,
    )
  })
  it('fxsocket/null provider still follows the global v2 switch', () => {
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b1', provider: 'fxsocket' }, { EXECUTION_ENGINE: 'v2' }), 'v2')
    assert.equal(resolveExecutionEngine({ brokerAccountId: 'b1', provider: null }, { EXECUTION_ENGINE: 'v2' }), 'v2')
  })
})

describe('splitBrokersByEngine', () => {
  const brokers = [{ id: 'b1', user_id: 'u1' }, { id: 'b2', user_id: 'u2' }, { id: 'b3', user_id: 'u1' }]
  it('routes everyone to v1 when the flag is off (zero behavior change)', () => {
    const { v1, v2 } = splitBrokersByEngine(brokers, {})
    assert.equal(v1.length, 3)
    assert.equal(v2.length, 0)
  })
  it('splits the named broker into the v2 lane only', () => {
    const { v1, v2 } = splitBrokersByEngine(brokers, { EXECUTION_ENGINE_V2_BROKERS: 'b2' })
    assert.deepEqual(v1.map(b => b.id), ['b1', 'b3'])
    assert.deepEqual(v2.map(b => b.id), ['b2'])
  })
  it('global switch puts everyone in v2', () => {
    const { v1, v2 } = splitBrokersByEngine(brokers, { EXECUTION_ENGINE: 'v2' })
    assert.equal(v1.length, 0)
    assert.equal(v2.length, 3)
  })
  it('global switch keeps MTAPI brokers in the v1 lane', () => {
    const mixed = [
      { id: 'b1', user_id: 'u1', provider: 'fxsocket' },
      { id: 'b2', user_id: 'u2', provider: 'mtapi' },
    ]
    const { v1, v2 } = splitBrokersByEngine(mixed, { EXECUTION_ENGINE: 'v2' })
    assert.deepEqual(v1.map(b => b.id), ['b2'])
    assert.deepEqual(v2.map(b => b.id), ['b1'])
  })
})
