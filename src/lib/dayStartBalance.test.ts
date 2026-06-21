import { describe, test, expect } from 'vitest'
import { resolveDisplayedTodayProfit, resolveDayStartBalance, aggregateTodaysProfitFromDayStart } from './dayStartBalance'

test('resolveDisplayedTodayProfit: chart wins when balance delta is zeroed', () => {
  expect(
    resolveDisplayedTodayProfit({
      balanceDelta: 0,
      balanceDayReady: true,
      chartNetPnl: 8420.5,
      chartHasData: true,
    }),
  ).toBe(8420.5)
})

test('resolveDisplayedTodayProfit: uses chart net when trade data exists', () => {
  expect(
    resolveDisplayedTodayProfit({
      balanceDelta: 9000,
      balanceDayReady: true,
      chartNetPnl: 8420.5,
      chartHasData: true,
    }),
  ).toBe(8420.5)
})

test('resolveDisplayedTodayProfit: ignores balance-only deposit inflation', () => {
  expect(
    resolveDisplayedTodayProfit({
      balanceDelta: 50_000,
      balanceDayReady: true,
      chartNetPnl: 120,
      chartHasData: true,
    }),
  ).toBe(120)
})

test('resolveDisplayedTodayProfit: zero when no closed trades today', () => {
  expect(
    resolveDisplayedTodayProfit({
      balanceDelta: 10_000,
      balanceDayReady: true,
      chartNetPnl: 0,
      chartHasData: false,
    }),
  ).toBe(0)
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
  expect(r.rolled).toBe(true)
  expect(r.dayStartBalance).toBe(41_000)
})

test('aggregateTodaysProfitFromDayStart includes copy-paused connected brokers', () => {
  const profit = aggregateTodaysProfitFromDayStart(
    [
      {
        id: 'paused',
        is_active: false,
        connection_status: 'connected',
        day_start_balance: 1000,
        day_start_balance_on: '2026-05-18',
      },
    ],
    { paused: { balance: 1050 } },
    '2026-05-18',
    { connectedOnly: true },
  )
  expect(profit).toBe(50)
})
