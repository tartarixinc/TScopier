import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDefaultChannelTradingConfig,
  channelConfigReadyForExecution,
  channelManualSettingsComplete,
  normalizeChannelTradingConfigsMap,
  resolveChannelTradingConfig,
  withChannelTradingConfig,
} from './channelTradingConfig'

test('resolveChannelTradingConfig falls back to broker-level settings when channel is not linked', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single' },
    ai_settings: { risk_percent_per_trade: 2 },
    channel_trading_configs: {},
    signal_channel_ids: ['other-ch'],
  }
  const resolved = resolveChannelTradingConfig(broker, 'ch-1')
  assert.equal(resolved.copier_mode, 'manual')
  assert.equal(resolved.manual_settings.fixed_lot, 0.05)
  assert.equal(resolved.config_source, 'broker_fallback')
  assert.equal(resolved.ai_settings.risk_percent_per_trade, 2)
})

test('linked channel missing config heals from broker manual_settings when sole channel', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.03, trade_style: 'single', risk_mode: 'fixed_lot' },
    ai_settings: {},
    channel_trading_configs: {},
    signal_channel_ids: ['signal-tester'],
  }
  const ready = channelConfigReadyForExecution(broker, 'signal-tester')
  assert.equal(ready.ready, true)
  if (ready.ready) assert.equal(ready.source, 'per_channel')
  const resolved = resolveChannelTradingConfig(broker, 'signal-tester')
  assert.equal(resolved.manual_settings.fixed_lot, 0.03)
  assert.equal(resolved.manual_settings.trade_style, 'single')
})

test('linked channel missing config stays blocked when broker manual_settings incomplete and multi-channel', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.03, trade_style: 'single' },
    channel_trading_configs: {},
    signal_channel_ids: ['channel-a', 'channel-b'],
  }
  const ready = channelConfigReadyForExecution(broker, 'channel-b')
  assert.equal(ready.ready, true)
  const resolved = resolveChannelTradingConfig(broker, 'channel-b')
  assert.equal(resolved.manual_settings.fixed_lot, 0.01)
})

test('linked channel with empty manual_settings heals from broker manual_settings', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.02, trade_style: 'multi', risk_mode: 'fixed_lot' },
    channel_trading_configs: {
      'signal-tester': { copier_mode: 'manual', manual_settings: {} },
    },
    signal_channel_ids: ['signal-tester'],
  }
  const ready = channelConfigReadyForExecution(broker, 'signal-tester')
  assert.equal(ready.ready, true)
  const resolved = resolveChannelTradingConfig(broker, 'signal-tester')
  assert.equal(resolved.manual_settings.fixed_lot, 0.02)
  assert.equal(resolved.manual_settings.trade_style, 'multi')
})

test('resolveChannelTradingConfig uses per-channel override', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single' },
    ai_settings: {},
    channel_trading_configs: {
      'ch-a': { copier_mode: 'manual' as const, manual_settings: { fixed_lot: 0.02, trade_style: 'multi' } },
      'ch-b': { copier_mode: 'manual' as const, manual_settings: { fixed_lot: 0.08, trade_style: 'single' } },
    },
    signal_channel_ids: ['ch-a', 'ch-b'],
  }
  const a = resolveChannelTradingConfig(broker, 'ch-a')
  const b = resolveChannelTradingConfig(broker, 'ch-b')
  assert.equal(a.manual_settings.trade_style, 'multi')
  assert.equal(a.manual_settings.fixed_lot, 0.02)
  assert.equal(a.config_source, 'per_channel')
  assert.equal(b.manual_settings.fixed_lot, 0.08)
  assert.equal(b.config_source, 'per_channel')
})

test('multi-channel isolation: each channel keeps its own lot and style', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single' },
    channel_trading_configs: {
      'signal-tester': {
        copier_mode: 'manual' as const,
        manual_settings: { fixed_lot: 0.03, trade_style: 'single', risk_mode: 'fixed_lot' },
      },
      'multi-ch': {
        copier_mode: 'manual' as const,
        manual_settings: { fixed_lot: 0.02, trade_style: 'multi', risk_mode: 'fixed_lot' },
      },
    },
    signal_channel_ids: ['signal-tester', 'multi-ch'],
  }
  const single = withChannelTradingConfig(broker, 'signal-tester')
  const multi = withChannelTradingConfig(broker, 'multi-ch')
  assert.equal(single.manual_settings.fixed_lot, 0.03)
  assert.equal(single.manual_settings.trade_style, 'single')
  assert.equal(multi.manual_settings.fixed_lot, 0.02)
  assert.equal(multi.manual_settings.trade_style, 'multi')
})

test('withChannelTradingConfig overlays broker row', () => {
  const broker = {
    id: 'b1',
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single' },
    channel_trading_configs: {
      ch1: { manual_settings: { fixed_lot: 0.11, trade_style: 'single' } },
    },
    signal_channel_ids: ['ch1'],
  }
  const effective = withChannelTradingConfig(broker, 'ch1')
  assert.equal(effective.manual_settings.fixed_lot, 0.11)
  assert.equal(effective.id, 'b1')
})

test('buildDefaultChannelTradingConfig seeds manual defaults', () => {
  const cfg = buildDefaultChannelTradingConfig()
  assert.equal(cfg.copier_mode, 'manual')
  assert.equal(cfg.manual_settings?.trade_style, 'single')
  assert.equal(cfg.manual_settings?.fixed_lot, 0.01)
})

test('normalizeChannelTradingConfigsMap skips invalid entries', () => {
  const map = normalizeChannelTradingConfigsMap({
    ok: { copier_mode: 'manual', manual_settings: { fixed_lot: 0.01, trade_style: 'single' } },
    '': { copier_mode: 'manual' },
    bad: 'nope',
  })
  assert.ok(map.ok)
  assert.equal(Object.keys(map).length, 1)
})
