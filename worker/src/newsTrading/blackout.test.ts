import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findActiveNewsBlackout } from './blackout'
import type { EconomicCalendarEvent } from './types'

const manualOff = {
  news_trading_enabled: false,
  news_avoid_impacts: ['high' as const],
  close_before_news_minutes: 30,
  resume_after_news_minutes: 15,
}

test('findActiveNewsBlackout: blocks in pre-news window for matching symbol', () => {
  const eventTime = new Date('2026-05-16T14:00:00.000Z')
  const events: EconomicCalendarEvent[] = [
    {
      id: '1',
      datetime: eventTime.toISOString(),
      country: 'US',
      currency: 'USD',
      event: 'NFP',
      impact: 'high',
    },
  ]
  const now = new Date(eventTime.getTime() - 20 * 60_000)
  const hit = findActiveNewsBlackout(events, manualOff, 'EURUSD', now)
  assert.ok(hit)
  assert.equal(hit?.phase, 'pre')
})

test('findActiveNewsBlackout: allows when news trading enabled', () => {
  const eventTime = new Date('2026-05-16T14:00:00.000Z')
  const events: EconomicCalendarEvent[] = [
    {
      id: '1',
      datetime: eventTime.toISOString(),
      country: 'US',
      currency: 'USD',
      event: 'NFP',
      impact: 'high',
    },
  ]
  const now = new Date(eventTime.getTime() - 5 * 60_000)
  const hit = findActiveNewsBlackout(events, { news_trading_enabled: true }, 'EURUSD', now)
  assert.equal(hit, null)
})

test('findActiveNewsBlackout: ignores non-matching currency', () => {
  const eventTime = new Date('2026-05-16T14:00:00.000Z')
  const events: EconomicCalendarEvent[] = [
    {
      id: '1',
      datetime: eventTime.toISOString(),
      country: 'JP',
      currency: 'JPY',
      event: 'BoJ',
      impact: 'high',
    },
  ]
  const now = new Date(eventTime.getTime() - 5 * 60_000)
  const hit = findActiveNewsBlackout(events, manualOff, 'EURUSD', now)
  assert.equal(hit, null)
})
