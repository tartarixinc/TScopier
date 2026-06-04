import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySymbolMapping } from './helpers'
import { resolveBrokerSymbolFromInventory } from './brokerSymbolCache'
import type { SymbolListCacheEntry } from './types'

function inventory(symbols: string[]): SymbolListCacheEntry {
  const list = [...symbols]
  return { list, set: new Set(list.map(s => s.toUpperCase())), loadedAt: Date.now() }
}

const noopCtx = {} as Parameters<typeof resolveBrokerSymbolFromInventory>[0]

test('applySymbolMapping: suffix marks userDecorated', () => {
  const broker = {
    manual_settings: { symbol_suffix: '+' },
  } as Parameters<typeof applySymbolMapping>[1]
  const r = applySymbolMapping('XAUUSD', broker)
  assert.equal(r.symbol, 'XAUUSD+')
  assert.equal(r.userDecorated, true)
})

test('resolveBrokerSymbolFromInventory: userDecorated keeps XAUUSD+ when both exist', () => {
  const inv = inventory(['XAUUSD', 'XAUUSD+'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD+', { userDecorated: true })
  assert.equal(resolved, 'XAUUSD+')
})

test('resolveBrokerSymbolFromInventory: fuzzy maps XAUUSD to XAUUSD+ when only suffixed exists', () => {
  const inv = inventory(['XAUUSD+'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD')
  assert.equal(resolved, 'XAUUSD+')
})

test('resolveBrokerSymbolFromInventory: userDecorated does not downgrade to bare XAUUSD', () => {
  const inv = inventory(['XAUUSD', 'XAUUSD+'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD+', { userDecorated: true })
  assert.equal(resolved, 'XAUUSD+')
})

test('resolveBrokerSymbolFromInventory: userDecorated returns requested when missing from list', () => {
  const inv = inventory(['EURUSD'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD+', { userDecorated: true })
  assert.equal(resolved, 'XAUUSD+')
})
