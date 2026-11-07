import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateSocialCopyOpenFilters } from './socialCopyFilters'

describe('evaluateSocialCopyOpenFilters', () => {
  it('allows all symbols by default', () => {
    assert.equal(evaluateSocialCopyOpenFilters({ symbol: 'XAUUSD', manualSettings: {} }), null)
  })

  it('skips symbols outside the allow list', () => {
    assert.equal(
      evaluateSocialCopyOpenFilters({
        symbol: 'BTCUSD',
        manualSettings: { symbol_to_trade: 'XAUUSD,EURUSD' },
      }),
      'symbol_not_allowed',
    )
  })

  it('skips excluded symbols', () => {
    assert.equal(
      evaluateSocialCopyOpenFilters({
        symbol: 'US30',
        manualSettings: { symbols_exclude: ['US30'] },
      }),
      'symbol_excluded',
    )
  })

  it('skips outside configured weekdays', () => {
    const monday = new Date(2026, 10, 9, 12, 0, 0) // local Monday
    assert.equal(monday.getDay(), 1)
    assert.equal(
      evaluateSocialCopyOpenFilters({
        symbol: 'XAUUSD',
        manualSettings: { days_filter_enabled: true, trade_days: [2, 3, 4] },
        now: monday,
      }),
      'filtered_day',
    )
  })

  it('skips outside configured time window', () => {
    const now = new Date('2026-11-09T08:00:00')
    assert.equal(
      evaluateSocialCopyOpenFilters({
        symbol: 'XAUUSD',
        manualSettings: {
          time_filter_enabled: true,
          trade_start_time: '09:00',
          trade_end_time: '17:00',
        },
        now,
      }),
      'filtered_time',
    )
  })

  it('skips during a news blackout when news trading is off', () => {
    const now = new Date('2026-11-09T12:00:00Z')
    assert.equal(
      evaluateSocialCopyOpenFilters({
        symbol: 'EURUSD',
        manualSettings: {
          news_trading_enabled: false,
          news_avoid_impacts: ['high'],
          close_before_news_minutes: 30,
          resume_after_news_minutes: 15,
        },
        newsEvents: [{
          id: 'ec-1',
          datetime: '2026-11-09T12:10:00.000Z',
          country: 'US',
          currency: 'USD',
          event: 'CPI',
          impact: 'high',
        }],
        now,
      }),
      'news_blackout',
    )
  })
})
