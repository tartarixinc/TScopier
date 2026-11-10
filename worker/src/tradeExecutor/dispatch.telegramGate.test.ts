import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isNonTelegramSignalSource,
  isTradingViewChannelSource,
  isTradingViewSignalSource,
  isTradingViewSourceChannel,
} from './dispatch'
import type { TradeExecutorContext } from './context'

test('whatsapp, discord, and tradingview dispatch hints skip the telegram listener gate', () => {
  assert.equal(isNonTelegramSignalSource('whatsapp'), true)
  assert.equal(isNonTelegramSignalSource('listener_push', 'discord'), true)
  assert.equal(isNonTelegramSignalSource('tradingview'), true)
  assert.equal(isNonTelegramSignalSource('tradingview_webhook'), true)
  assert.equal(isNonTelegramSignalSource('listener_push', undefined), false)
  assert.equal(isNonTelegramSignalSource('telegram'), false)
})

test('tradingview_webhook is a TradingView signal source; discord is not', async () => {
  assert.equal(isTradingViewSignalSource('tradingview_webhook'), true)
  assert.equal(isTradingViewSignalSource('tradingview'), true)
  assert.equal(isTradingViewSignalSource('discord'), false)
  assert.equal(isTradingViewSignalSource('whatsapp'), false)

  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { source_kind: 'tradingview' }, error: null }),
        }),
      }),
    }),
  } as unknown as TradeExecutorContext['supabase']
  assert.equal(await isTradingViewChannelSource(supabase, 'channel-tv'), true)
})

test('a whatsapp channel row skips the telegram listener gate without a dispatch hint', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { source_kind: 'whatsapp' }, error: null }),
        }),
      }),
    }),
  } as unknown as TradeExecutorContext['supabase']

  assert.equal(await isTradingViewSourceChannel(supabase, 'channel-whatsapp-gate'), true)
})

test('a missing channel row does not count as a non-telegram source', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: 'missing' } }),
        }),
      }),
    }),
  } as unknown as TradeExecutorContext['supabase']

  assert.equal(await isTradingViewSourceChannel(supabase, 'channel-missing-gate'), false)
})
