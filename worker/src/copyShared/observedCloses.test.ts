import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  noteObservedClose,
  observedCloseRows,
  OBSERVED_CLOSE_MAX_AGE_MS,
  OBSERVED_CLOSE_MEMORY,
  type ObservedClose,
} from './observedCloses'

const base: Omit<ObservedClose, 'at'> = { ticket: 42, symbol: 'EURUSD', operation: 'Buy', lots: 0.1 }
const now = 1_761_500_000_000

test('observations are appended oldest first and evicted by age, then by count', () => {
  const closed: ObservedClose[] = []
  noteObservedClose(closed, { ...base, at: now - OBSERVED_CLOSE_MAX_AGE_MS - 1 })
  noteObservedClose(closed, { ...base, ticket: 1, at: now })
  assert.deepEqual(closed.map(row => row.ticket), [1], 'the stale observation is dropped on insert')

  const many: ObservedClose[] = []
  for (let i = 0; i < OBSERVED_CLOSE_MEMORY + 25; i += 1) {
    noteObservedClose(many, { ...base, ticket: i, at: now + i })
  }
  assert.equal(many.length, OBSERVED_CLOSE_MEMORY, 'the memory cap holds')
  assert.equal(many[0]!.ticket, 25, 'the oldest entries are the ones dropped')
  assert.equal(many[many.length - 1]!.ticket, OBSERVED_CLOSE_MEMORY + 24)
})

test('observed close rows only cover their window and never carry a fill value', () => {
  const closed: ObservedClose[] = [
    { ...base, ticket: 1, at: now - 1000 },
    { ...base, ticket: 2, at: now },
    { ...base, ticket: 3, at: now + 1000 },
  ]
  const rows = observedCloseRows(closed, now - 500, now + 500)
  assert.deepEqual(rows.map(row => row.ticket), [2])
  const [row] = rows
  assert.equal(row!.closeTime, now)
  assert.equal(row!.positionTicket, 2)
  assert.equal(row!.observed, 'position_gone')
  assert.equal('closePrice' in row, false, 'a value-less row can never be written as a fill')
  assert.equal('profit' in row, false)
})

test('rows outside the window are excluded on both sides', () => {
  const closed: ObservedClose[] = [{ ...base, ticket: 7, at: now }]
  assert.equal(observedCloseRows(closed, now + 1, now + 10).length, 0)
  assert.equal(observedCloseRows(closed, now - 10, now - 1).length, 0)
  assert.equal(observedCloseRows(closed, now, now).length, 1)
})
