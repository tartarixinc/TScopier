import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySymbolMapping } from './helpers'
import { resolveBrokerSymbolFromInventory } from './brokerSymbolCache'
import type { BrokerRow, SymbolListCacheEntry } from './types'

function inventory(symbols: string[]): SymbolListCacheEntry {
  const list = [...symbols]
  return { list, set: new Set(list.map(s => s.toUpperCase())), loadedAt: Date.now() }
}

const noopCtx = {} as Parameters<typeof resolveBrokerSymbolFromInventory>[0]

test('applySymbolMapping: suffix marks userDecorated', () => {
  const broker = {
    manual_settings: { symbol_suffix: '+' },
  } as unknown as BrokerRow
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

test('resolveBrokerSymbolFromInventory: exact XAUUSD remains exact when available', () => {
  const inv = inventory(['XAUUSD', 'XAUUSDm'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD')
  assert.equal(resolved, 'XAUUSD')
})

test('resolveBrokerSymbolFromInventory: fuzzy maps BTCUSD to BTCUSDm', () => {
  const inv = inventory(['BTCUSDm'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'BTCUSD')
  assert.equal(resolved, 'BTCUSDm')
})

test('applySymbolMapping: no decoration → userDecorated false', () => {
  const broker = {
    manual_settings: { symbol_prefix: '', symbol_suffix: '' },
  } as unknown as BrokerRow
  const r = applySymbolMapping('XAUUSD', broker)
  assert.equal(r.symbol, 'XAUUSD')
  assert.equal(r.userDecorated, false)
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

test('resolveBrokerSymbolFromInventory: XAUUSD maps to GOLD# on XM-style brokers', () => {
  const inv = inventory(['EURUSD', 'GOLD#', 'GOLD24-7#', 'BarrickGold', 'XAUEUR#'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD')
  assert.equal(resolved, 'GOLD#')
})

test('resolveBrokerSymbolFromInventory: XAUUSD maps to GOLD.pro when that is the broker metal symbol', () => {
  const inv = inventory(['EURUSD', 'GOLD.pro', 'BarrickGold'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD')
  assert.equal(resolved, 'GOLD.pro')
})

test('resolveBrokerSymbolFromInventory: GOLD maps to GOLD#', () => {
  const inv = inventory(['GOLD#'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'GOLD'), 'GOLD#')
})

test('resolveBrokerSymbolFromInventory: does not pick BarrickGold for XAUUSD', () => {
  const inv = inventory(['BarrickGold', 'Gold Fields', 'GoldmSachs'])
  const resolved = resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD')
  assert.equal(resolved, 'XAUUSD')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to US100', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['US100']), 'NAS100'), 'US100')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to USTEC', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['USTEC']), 'NAS100'), 'USTEC')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to NDX', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['NDX']), 'NAS100'), 'NDX')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to NASDAQ100', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['NASDAQ100']), 'NAS100'), 'NASDAQ100')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to suffixed index alias', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['USTEC.a']), 'NAS100'), 'USTEC.a')
})

test('resolveBrokerSymbolFromInventory: NAS100 resolves to prefixed index alias', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['mUS100']), 'NAS100'), 'mUS100')
})

test('resolveBrokerSymbolFromInventory: manual mapping beats automatic index aliasing', () => {
  const broker = {
    manual_settings: { symbol_mapping: { NAS100: 'NAS100.cash' } },
  } as unknown as BrokerRow
  const mapped = applySymbolMapping('NAS100', broker)
  assert.equal(mapped.symbol, 'NAS100.CASH')
  assert.equal(mapped.userDecorated, true)
  assert.equal(
    resolveBrokerSymbolFromInventory(noopCtx, inventory(['US100', 'NAS100.CASH']), mapped.symbol, {
      userDecorated: mapped.userDecorated,
    }),
    'NAS100.CASH',
  )
})

test('resolveBrokerSymbolFromInventory: exact NAS100 beats aliases', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['NAS100', 'US100']), 'NAS100'), 'NAS100')
})

test('resolveBrokerSymbolFromInventory: ambiguous index aliases do not guess', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['US100', 'USTEC']), 'NAS100'), 'NAS100')
})

test('resolveBrokerSymbolFromInventory: empty inventory does not fabricate index aliases', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory([]), 'NAS100'), 'NAS100')
})

test('resolveBrokerSymbolFromInventory: unsupported symbol remains requested', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['US100']), 'MOON100'), 'MOON100')
})

test('resolveBrokerSymbolFromInventory: SP500 family resolves safely', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['SPX500']), 'US500'), 'SPX500')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['S&P500']), 'SP500'), 'S&P500')
})

test('resolveBrokerSymbolFromInventory: Dow family resolves safely', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['DJ30']), 'US30'), 'DJ30')
})

test('resolveBrokerSymbolFromInventory: DAX family resolves safely', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['DE40.pro']), 'GER40'), 'DE40.pro')
})

test('resolveBrokerSymbolFromInventory: FTSE family resolves safely', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['FTSE100']), 'UK100'), 'FTSE100')
})

test('resolveBrokerSymbolFromInventory: Nikkei family resolves safely', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['NIKKEI225']), 'JP225'), 'NIKKEI225')
})

test('resolveBrokerSymbolFromInventory: FX behavior remains exact/prefix-suffix only', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['EURUSD', 'US100']), 'EURUSD'), 'EURUSD')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['EURUSD.R']), 'EURUSD'), 'EURUSD.R')
})

test('resolveBrokerSymbolFromInventory: Deriv synthetic behavior remains specialized', () => {
  const inv = inventory(['Volatility 75 Index', 'US100'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'R_75'), 'Volatility 75 Index')
})

test('resolveBrokerSymbolFromInventory: decorated master symbol resolves to the plain destination name', () => {
  const inv = inventory(['EURUSD', 'XAUUSD', 'BTCUSD', 'US30'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSDm'), 'XAUUSD')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'EURUSDm'), 'EURUSD')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'BTCUSDm'), 'BTCUSD')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'US30M'), 'US30')
})

test('resolveBrokerSymbolFromInventory: an existing decorated symbol wins over stripping', () => {
  const inv = inventory(['XAUUSD', 'XAUUSDm'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSDm'), 'XAUUSDm')
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSD'), 'XAUUSD')
})

test('resolveBrokerSymbolFromInventory: decorated gold still resolves through the metal alias to GOLD', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['GOLD']), 'XAUUSDm'), 'GOLD')
})

test('resolveBrokerSymbolFromInventory: dot-decorated source strips to the bare base', () => {
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inventory(['EURUSD']), 'EURUSD.R'), 'EURUSD')
})

test('resolveBrokerSymbolFromInventory: userDecorated never strips or guesses', () => {
  const inv = inventory(['XAUUSD'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSDm', { userDecorated: true }), 'XAUUSDm')
})

test('resolveBrokerSymbolFromInventory: no usable match returns the request unchanged', () => {
  const inv = inventory(['EURUSD'])
  assert.equal(resolveBrokerSymbolFromInventory(noopCtx, inv, 'XAUUSDm'), 'XAUUSDm')
})
