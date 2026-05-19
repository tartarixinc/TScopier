import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cweInstructionGroupKey,
  filterTradesWithinPipsOfReference,
  isEntryWithinPipsOfReference,
  parseCweInstructionGroupKey,
  referencePriceForDirection,
  selectTradesForCweInstruction,
} from './closeWorseEntries'

const pip = 0.1 // XAU-style

test('isEntryWithinPipsOfReference: buy ladder example', () => {
  const anchor = 4565.1
  const ref = anchor + 30 * pip // market +30 pips from signal entry
  assert.equal(isEntryWithinPipsOfReference(4565.1, ref, 30, pip), true)
  assert.equal(isEntryWithinPipsOfReference(4556.0, ref, 30, pip), false)
})

test('referencePriceForDirection uses bid for buy and ask for sell', () => {
  assert.equal(referencePriceForDirection('buy', 4595, 4595.2), 4595)
  assert.equal(referencePriceForDirection('sell', 4595, 4595.2), 4595.2)
})

test('filterTradesWithinPipsOfReference keeps only open legs in band', () => {
  const trades = [
    { id: '1', broker_account_id: 'b', metaapi_order_id: '1', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.01, entry_price: 4565.1, status: 'open' },
    { id: '2', broker_account_id: 'b', metaapi_order_id: '2', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.01, entry_price: 4556, status: 'open' },
    { id: '3', broker_account_id: 'b', metaapi_order_id: '3', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.01, entry_price: 4564, status: 'closed' },
  ]
  const ref = 4565.1 + 30 * pip
  const hit = filterTradesWithinPipsOfReference({
    trades,
    referencePrice: ref,
    pips: 30,
    pipSize: pip,
  })
  assert.equal(hit.length, 1)
  assert.equal(hit[0]!.id, '1')
})

test('cweInstructionGroupKey survives symbols with pipe characters', () => {
  const key = cweInstructionGroupKey({
    broker_account_id: 'broker-1',
    symbol: 'XAU|USD',
    direction: 'buy',
  })
  assert.equal(parseCweInstructionGroupKey(key)?.symbol, 'XAU|USD')
})

test('selectTradesForCweInstruction includes tagged CWE legs outside pip band', () => {
  const trades = [
    { id: '1', broker_account_id: 'b', metaapi_order_id: '1', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.01, entry_price: 4556, status: 'open', cwe_close_price: null },
    { id: '2', broker_account_id: 'b', metaapi_order_id: '2', symbol: 'XAUUSD', direction: 'buy', lot_size: 0.01, entry_price: 4500, status: 'open', cwe_close_price: 4595 },
  ]
  const ref = 4595
  const hit = selectTradesForCweInstruction({
    trades,
    referencePrice: ref,
    pips: 30,
    pipSize: pip,
  })
  assert.equal(hit.length, 1)
  assert.equal(hit[0]!.id, '2')
})
