import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { apiForBrokerAccount, inferProvider } from './providerResolver'

test('apiForBrokerAccount returns null for empty session ID', () => {
  assert.equal(apiForBrokerAccount('fxsocket', ''), null)
})

test('apiForBrokerAccount returns null for session ID containing pipe', () => {
  assert.equal(apiForBrokerAccount('fxsocket', 'abc|def'), null)
})

test('apiForBrokerAccount returns fxsocket provider for fxsocket provider name', () => {
  const provider = apiForBrokerAccount('fxsocket', 'test-session-123')
  assert.ok(provider, 'provider should not be null')
  assert.equal(provider.name, 'fxsocket')
})

test('apiForBrokerAccount falls back to fxsocket for unknown provider', () => {
  const provider = apiForBrokerAccount('unknown-provider', 'test-session-123')
  assert.ok(provider, 'provider should not be null')
  assert.equal(provider.name, 'fxsocket')
})

test('apiForBrokerAccount falls back to fxsocket for null provider', () => {
  const provider = apiForBrokerAccount(null, 'test-session-123')
  assert.ok(provider, 'provider should not be null')
  assert.equal(provider.name, 'fxsocket')
})

test('apiForBrokerAccount falls back to fxsocket for undefined provider', () => {
  const provider = apiForBrokerAccount(undefined, 'test-session-123')
  assert.ok(provider, 'provider should not be null')
  assert.equal(provider.name, 'fxsocket')
})

test('inferProvider returns mtapi when provider column is mtapi', () => {
  assert.equal(inferProvider({ provider: 'mtapi' }), 'mtapi')
})

test('inferProvider returns fxsocket when provider column is fxsocket', () => {
  assert.equal(inferProvider({ provider: 'fxsocket' }), 'fxsocket')
})

test('inferProvider returns fxsocket when provider column is empty', () => {
  assert.equal(inferProvider({ provider: '' }), 'fxsocket')
})

test('inferProvider returns fxsocket when provider column is null', () => {
  assert.equal(inferProvider({ provider: null }), 'fxsocket')
})

test('inferProvider returns fxsocket when provider column is undefined', () => {
  assert.equal(inferProvider({}), 'fxsocket')
})

test('inferProvider returns fxsocket when metaapi_account_id is set but provider is not mtapi', () => {
  assert.equal(inferProvider({ metaapi_account_id: 'some-id' }), 'fxsocket')
})
