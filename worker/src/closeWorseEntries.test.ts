import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cweInstructionGroupKey,
  filterTradesWithinPipsOfReference,
  isEntryWithinPipsOfReference,
  loadFiredRangeLayeringTickets,
  parseCweInstructionGroupKey,
  referencePriceForDirection,
  selectImmediateLegsForCweInstruction,
  selectTradesForCweInstruction,
  selectWorseImmediateLegsForCweInstruction,
} from './closeWorseEntries'

const pip = 0.1 // XAU-style

const trade = (
  id: string,
  ticket: string,
  extra?: Partial<{ signal_id: string; cwe_close_price: number | null; entry_price: number }>,
) => ({
  id,
  signal_id: extra?.signal_id ?? 'sig-1',
  broker_account_id: 'b',
  metaapi_order_id: ticket,
  symbol: 'XAUUSD',
  direction: 'buy',
  lot_size: 0.01,
  entry_price: extra?.entry_price ?? 4565.1,
  status: 'open',
  cwe_close_price: extra?.cwe_close_price ?? null,
})

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
    trade('1', '1'),
    { ...trade('2', '2'), entry_price: 4556 },
    { ...trade('3', '3'), status: 'closed' },
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

test('selectWorseImmediateLegsForCweInstruction keeps better fills outside pip band', () => {
  const trades = [
    trade('instant', '1001', { entry_price: 4565.1 }),
    { ...trade('better', '1002'), entry_price: 4556 },
    { ...trade('layer', '1010'), entry_price: 4540 },
  ]
  const layering = new Set(['1010'])
  const ref = 4565.1 + 30 * pip
  const hit = selectWorseImmediateLegsForCweInstruction({
    trades,
    layeringTickets: layering,
    referencePrice: ref,
    pips: 30,
    pipSize: pip,
  })
  assert.equal(hit.length, 1)
  assert.equal(hit[0]!.id, 'instant')
})

test('selectImmediateLegsForCweInstruction closes immediates only', () => {
  const trades = Array.from({ length: 33 }, (_, i) => trade(`imm-${i}`, String(1000 + i)))
  const layering = new Set(['1010', '1011', '1012'])
  const hit = selectImmediateLegsForCweInstruction(trades, layering)
  assert.equal(hit.length, 30)
  assert.ok(hit.every(t => !layering.has(String(t.metaapi_order_id))))
})

test('selectImmediateLegsForCweInstruction skips open trades without ticket', () => {
  const trades = [
    trade('1', '1001'),
    { ...trade('2', ''), metaapi_order_id: '' },
  ]
  const hit = selectImmediateLegsForCweInstruction(trades, new Set())
  assert.equal(hit.length, 1)
  assert.equal(hit[0]!.id, '1')
})

test('loadFiredRangeLayeringTickets returns fired pending tickets', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        in: () => ({
          eq: () => ({
            eq: async () => ({
              data: [
                { ticket: '5001', symbol: 'XAUUSD' },
                { ticket: '5002', symbol: 'XAUUSD+' },
                { ticket: '5003', symbol: 'BTCUSD' },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }),
  }
  const tickets = await loadFiredRangeLayeringTickets(supabase as never, {
    signalIds: ['sig-1'],
    brokerAccountId: 'broker-1',
    symbol: 'XAUUSD',
  })
  assert.equal(tickets.size, 2)
  assert.ok(tickets.has('5001'))
  assert.ok(tickets.has('5002'))
})

test('selectTradesForCweInstruction legacy includes tagged CWE legs outside pip band', () => {
  const trades = [
    { ...trade('1', '1'), entry_price: 4556, cwe_close_price: null },
    { ...trade('2', '2'), entry_price: 4500, cwe_close_price: 4595 },
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
