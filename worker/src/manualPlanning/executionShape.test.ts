import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { MtOperation } from '../fxsocketClient'
import { resolveOpExecAndStrict } from './executionShape'

const base = {
  resolvedSymbol: 'EURUSD',
  commentPrefix: 't',
  slippage: 20,
  now: new Date('2026-01-01T12:00:00Z'),
  pendingExpiryRaw: 4,
  roundPrice: (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : Number(v.toFixed(5))),
}

function op(
  overrides: Partial<Parameters<typeof resolveOpExecAndStrict>[0]> & {
    opSplit: MtOperation
    isBuy: boolean
    entryAnchor: number | null
    manualStrict: boolean
    hasExplicitEntry: boolean
  },
) {
  return resolveOpExecAndStrict({ ...base, ...overrides })
}

test('resolveOpExecAndStrict: strict + explicit entry → market Buy/Sell', () => {
  const r = op({
    opSplit: 'BuyLimit',
    isBuy: true,
    entryAnchor: 1.1,
    manualStrict: true,
    hasExplicitEntry: true,
  })
  assert.equal(r.opExec, 'Buy')
  assert.equal(r.orderPrice, 0)
  assert.ok(r.strictEntry)
  assert.equal(r.strictEntry?.entryPrice, 1.1)
})

test('resolveOpExecAndStrict: strict off + BuyLimit → market (single and multi)', () => {
  const r = op({
    opSplit: 'BuyLimit',
    isBuy: true,
    entryAnchor: 1.1,
    manualStrict: false,
    hasExplicitEntry: true,
  })
  assert.equal(r.opExec, 'Buy')
  assert.equal(r.orderPrice, 0)
  assert.equal(r.strictEntry, undefined)
})

test('resolveOpExecAndStrict: strict without anchor does not force market op', () => {
  const r = op({
    opSplit: 'BuyLimit',
    isBuy: true,
    entryAnchor: null,
    manualStrict: true,
    hasExplicitEntry: false,
  })
  assert.equal(r.opExec, 'BuyLimit')
})

test('resolveOpExecAndStrict: pending keeps expiration when strict leaves BuyLimit', () => {
  const r = op({
    opSplit: 'BuyLimit',
    isBuy: true,
    entryAnchor: null,
    manualStrict: true,
    hasExplicitEntry: false,
    pendingExpiryRaw: 2,
  })
  assert.ok(r.expirationFields.expiration)
  assert.equal(r.expirationFields.expirationType, 'Specified')
})

test('resolveOpExecAndStrict: market has no expiration', () => {
  const r = op({
    opSplit: 'BuyLimit',
    isBuy: true,
    entryAnchor: 1.1,
    manualStrict: true,
    hasExplicitEntry: true,
  })
  assert.equal(r.expirationFields.expiration, undefined)
})
