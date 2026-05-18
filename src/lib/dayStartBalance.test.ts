import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveDisplayedTodayProfit, resolveDayStartBalance } from './dayStartBalance'

test('resolveDisplayedTodayProfit: chart wins when balance delta is zeroed', () => {
  assert.equal(
    resolveDisplayedTodayProfit({
      balanceDelta: 0,
      balanceDayReady: true,
      chartNetPnl: 8420.5,
      chartHasData: true,
    }),
    8420.5,
  )
})

test('resolveDisplayedTodayProfit: uses balance when non-zero', () => {
  assert.equal(
    resolveDisplayedTodayProfit({
      balanceDelta: 9000,
      balanceDayReady: true,
      chartNetPnl: 8420.5,
      chartHasData: true,
    }),
    9000,
  )
})

test('resolveDayStartBalance: same-day resync uses last balance not current', () => {
  const r = resolveDayStartBalance({
    calendarDay: '2026-05-18',
    currentBalance: 50_000,
    storedDay: null,
    storedStart: null,
    lastBalance: 41_000,
    lastSyncedAt: '2026-05-18T08:00:00.000Z',
    timezoneOffsetMinutes: 0,
  })
  assert.equal(r.rolled, true)
  assert.equal(r.dayStartBalance, 41_000)
})
