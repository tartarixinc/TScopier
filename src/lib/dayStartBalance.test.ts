import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  accountTodaysProfitFromBalance,
  aggregateTodaysProfitFromDayStart,
  resolveDayStartBalance,
} from './dayStartBalance'

test('resolveDayStartBalance: keeps same-day snapshot', () => {
  const r = resolveDayStartBalance({
    calendarDay: '2026-05-18',
    currentBalance: 10_000,
    storedDay: '2026-05-18',
    storedStart: 9_000,
    lastBalance: 9_500,
    lastSyncedAt: '2026-05-18T08:00:00.000Z',
    timezoneOffsetMinutes: 0,
  })
  assert.equal(r.rolled, false)
  assert.equal(r.dayStartBalance, 9_000)
})

test('resolveDayStartBalance: new day uses last balance from prior sync day', () => {
  const r = resolveDayStartBalance({
    calendarDay: '2026-05-18',
    currentBalance: 10_883,
    storedDay: '2026-05-17',
    storedStart: 9_000,
    lastBalance: 10_000,
    lastSyncedAt: '2026-05-17T22:00:00.000Z',
    timezoneOffsetMinutes: 0,
  })
  assert.equal(r.rolled, true)
  assert.equal(r.dayStartBalance, 10_000)
  assert.equal(r.dayStartOn, '2026-05-18')
})

test('accountTodaysProfitFromBalance: current minus day start', () => {
  const profit = accountTodaysProfitFromBalance(10_883.9, 10_000, '2026-05-18', '2026-05-18')
  assert.ok(profit != null && Math.abs(profit - 883.9) < 0.01)
  assert.equal(accountTodaysProfitFromBalance(10_883.9, 10_000, '2026-05-17', '2026-05-18'), null)
})

test('aggregateTodaysProfitFromDayStart: sums connected accounts', () => {
  const total = aggregateTodaysProfitFromDayStart(
    [
      {
        id: 'a',
        is_active: true,
        connection_status: 'connected',
        day_start_balance: 100,
        day_start_balance_on: '2026-05-18',
      },
      {
        id: 'b',
        is_active: true,
        connection_status: 'connected',
        day_start_balance: 200,
        day_start_balance_on: '2026-05-18',
      },
    ],
    { a: { balance: 150 }, b: { balance: 250 } },
    '2026-05-18',
    { connectedOnly: true },
  )
  assert.equal(total, 100)
})
