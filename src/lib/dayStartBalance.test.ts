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

test('resolveDisplayedTodayProfit: uses chart net when trade data exists', () => {
  assert.equal(
    resolveDisplayedTodayProfit({
      balanceDelta: 9000,
      balanceDayReady: true,
      chartNetPnl: 8420.5,
      chartHasData: true,
    }),
    8420.5,
  )
})

test('resolveDisplayedTodayProfit: ignores balance-only deposit inflation', () => {
  assert.equal(
    resolveDisplayedTodayProfit({
      balanceDelta: 50_000,
      balanceDayReady: true,
      chartNetPnl: 120,
      chartHasData: true,
    }),
    120,
  )
})

test('resolveDisplayedTodayProfit: zero when no closed trades today', () => {
  assert.equal(
    resolveDisplayedTodayProfit({
      balanceDelta: 10_000,
      balanceDayReady: true,
      chartNetPnl: 0,
      chartHasData: false,
    }),
    0,
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
