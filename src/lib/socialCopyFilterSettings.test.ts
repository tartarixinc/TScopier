import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOCIAL_COPY_FILTER_SETTINGS,
  normalizeSocialCopyFilterSettings,
  parseSymbolText,
} from './socialCopyFilterSettings'

describe('normalizeSocialCopyFilterSettings', () => {
  it('returns defaults for empty input', () => {
    expect(normalizeSocialCopyFilterSettings(null)).toEqual(DEFAULT_SOCIAL_COPY_FILTER_SETTINGS)
  })

  it('keeps allow/avoid symbols and news windows', () => {
    expect(normalizeSocialCopyFilterSettings({
      symbol_to_trade: ' xauusd, eurusd ',
      symbols_exclude: ['btcusd', ''],
      news_trading_enabled: false,
      news_avoid_impacts: ['high', 'medium', 'nope'],
      close_before_news_minutes: 45,
      resume_after_news_minutes: 20,
      trade_days: [1, 9, 3],
      days_filter_enabled: true,
    })).toEqual({
      symbol_to_trade: 'xauusd, eurusd',
      symbols_exclude: ['BTCUSD'],
      time_filter_enabled: false,
      trade_start_time: '00:00',
      trade_end_time: '23:59',
      days_filter_enabled: true,
      trade_days: [1, 3],
      news_trading_enabled: false,
      allow_high_impact_news: false,
      news_avoid_impacts: ['high', 'medium'],
      close_before_news_minutes: 45,
      resume_after_news_minutes: 20,
    })
  })

  it('parses symbol text lists', () => {
    expect(parseSymbolText('XAUUSD; EURUSD  GBPUSD')).toEqual(['XAUUSD', 'EURUSD', 'GBPUSD'])
  })
})
