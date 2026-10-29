import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeSingleTpLotBreakdown, computeSingleTpPartialShortfall } from './singleTpLotBreakdown.ts'

const DEFAULT_ROWS = [
  { label: 'TP1', percent: 50, enabled: true },
  { label: 'TP2', percent: 30, enabled: true },
  { label: 'TP3', percent: 20, enabled: true },
]

test('farthest + 50/30/20 on 0.5 lot → 0.25 / 0.15 / 0.10', () => {
  const slices = computeSingleTpLotBreakdown({
    manualLot: 0.5,
    singleTpTarget: 'farthest',
    tpLots: DEFAULT_ROWS,
  })
  assert.deepEqual(
    slices.map(s => ({ tp: s.tpLabel, lots: s.lots })),
    [
      { tp: 'TP1', lots: 0.25 },
      { tp: 'TP2', lots: 0.15 },
      { tp: 'TP3', lots: 0.1 },
    ],
  )
})

test('farthest + 50/30/20 on 1.0 lot → 0.50 / 0.30 / 0.20', () => {
  const slices = computeSingleTpLotBreakdown({
    manualLot: 1,
    singleTpTarget: 'farthest',
    tpLots: DEFAULT_ROWS,
  })
  assert.deepEqual(
    slices.map(s => ({ tp: s.tpLabel, lots: s.lots })),
    [
      { tp: 'TP1', lots: 0.5 },
      { tp: 'TP2', lots: 0.3 },
      { tp: 'TP3', lots: 0.2 },
    ],
  )
})

test('tp1 puts full lot on TP1 only', () => {
  const slices = computeSingleTpLotBreakdown({
    manualLot: 0.5,
    singleTpTarget: 'tp1',
    tpLots: DEFAULT_ROWS,
  })
  assert.deepEqual(slices, [{ tpLabel: 'TP1', tpIdx: 1, lots: 0.5 }])
})

test('tp2: partial at TP1, remainder at TP2', () => {
  const slices = computeSingleTpLotBreakdown({
    manualLot: 0.5,
    singleTpTarget: 'tp2',
    tpLots: DEFAULT_ROWS,
  })
  assert.deepEqual(
    slices.map(s => ({ tp: s.tpLabel, lots: s.lots })),
    [
      { tp: 'TP1', lots: 0.25 },
      { tp: 'TP2', lots: 0.25 },
    ],
  )
})

test('invalid lot returns empty', () => {
  assert.deepEqual(
    computeSingleTpLotBreakdown({ manualLot: 0, singleTpTarget: 'farthest', tpLots: DEFAULT_ROWS }),
    [],
  )
})

test('partial shortfall: 0.01 lot cannot split 50/30/20', () => {
  const out = computeSingleTpPartialShortfall({
    manualLot: 0.01,
    singleTpTarget: 'farthest',
    tpLots: DEFAULT_ROWS,
  })
  assert.ok(out)
  assert.deepEqual(out!.dropped, ['TP1', 'TP2'])
})

test('partial shortfall: 0.08 lot schedules every level', () => {
  const out = computeSingleTpPartialShortfall({
    manualLot: 0.08,
    singleTpTarget: 'farthest',
    tpLots: DEFAULT_ROWS,
  })
  assert.equal(out, null)
})

test('partial shortfall: tp1 target means no partials by design', () => {
  const out = computeSingleTpPartialShortfall({
    manualLot: 0.01,
    singleTpTarget: 'tp1',
    tpLots: DEFAULT_ROWS,
  })
  assert.equal(out, null)
})

test('partial shortfall: single enabled row never warns', () => {
  const out = computeSingleTpPartialShortfall({
    manualLot: 0.01,
    singleTpTarget: 'farthest',
    tpLots: [{ label: 'TP1', percent: 100, enabled: true }],
  })
  assert.equal(out, null)
})

test('partial shortfall: 0.02 lot with 50/30/20 keeps TP1, drops TP2', () => {
  const out = computeSingleTpPartialShortfall({
    manualLot: 0.02,
    singleTpTarget: 'farthest',
    tpLots: DEFAULT_ROWS,
  })
  assert.ok(out)
  assert.deepEqual(out!.dropped, ['TP2'])
})
