import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergeSignalsWithOpenFallbacks, pinOpenSignalsFirst } from './signalListMerge'

test('mergeSignalsWithOpenFallbacks: appends missing fallbacks after the loaded page', () => {
  const loaded = [{ id: 'new-1' }, { id: 'new-2' }]
  const fallbacks = [{ id: 'open-old' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, fallbacks)
  assert.deepEqual(merged.map(r => r.id), ['new-1', 'new-2', 'open-old'])
})

test('mergeSignalsWithOpenFallbacks: duplicate ids keep the loaded row', () => {
  const loaded = [{ id: 'sig', v: 1 }]
  const fallbacks = [{ id: 'sig', v: 2 }, { id: 'open-old', v: 3 }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, fallbacks)
  assert.deepEqual(merged, [{ id: 'sig', v: 1 }, { id: 'open-old', v: 3 }])
})

test('mergeSignalsWithOpenFallbacks: empty fallbacks returns loaded rows unchanged', () => {
  const loaded = [{ id: 'a' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, [])
  assert.deepEqual(merged, [{ id: 'a' }])
  assert.notEqual(merged, loaded)
})

test('mergeSignalsWithOpenFallbacks: all duplicates returns a copy of loaded rows', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, [{ id: 'b' }])
  assert.deepEqual(merged, [{ id: 'a' }, { id: 'b' }])
})

test('pinOpenSignalsFirst: open signals lead the list, closed ones follow', () => {
  const rows = [
    { id: 'closed-1', openStatus: 'closed' as const },
    { id: 'open-1', openStatus: 'open' as const },
    { id: 'closed-2', openStatus: 'closed' as const },
    { id: 'open-2', openStatus: 'open' as const },
  ]
  assert.deepEqual(pinOpenSignalsFirst(rows).map(r => r.id), ['open-1', 'open-2', 'closed-1', 'closed-2'])
})

test('pinOpenSignalsFirst: each group keeps its newest-first order', () => {
  const rows = [
    { id: 'closed-newest', openStatus: 'closed' as const },
    { id: 'closed-older', openStatus: 'closed' as const },
    { id: 'open-newest', openStatus: 'open' as const },
    { id: 'open-older', openStatus: 'open' as const },
  ]
  assert.deepEqual(
    pinOpenSignalsFirst(rows).map(r => r.id),
    ['open-newest', 'open-older', 'closed-newest', 'closed-older'],
  )
})

test('pinOpenSignalsFirst: empty and single-row lists come back as copies', () => {
  assert.deepEqual(pinOpenSignalsFirst([]), [])
  const one = [{ id: 'only', openStatus: 'closed' as const }]
  const out = pinOpenSignalsFirst(one)
  assert.deepEqual(out, one)
  assert.notEqual(out, one)
})
