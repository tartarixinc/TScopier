import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDefaultChannelTradingConfig,
  channelConfigReadyForExecution,
  healPersistWithinCooldown,
  healedConfigPersistDiffers,
  normalizeChannelTradingConfigsMap,
  persistHealedChannelConfigs,
  resetHealPersistCooldownsForTests,
  resolveChannelTradingConfig,
  withChannelTradingConfig,
} from './channelTradingConfig'
import { applySymbolMapping } from './tradeExecutor/helpers'

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

test('multi-channel missing per-channel config heals from defaults, not broker manual_settings', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.03, trade_style: 'single', risk_mode: 'fixed_lot' },
    channel_trading_configs: {},
    signal_channel_ids: ['channel-a', 'channel-b'],
  }
  const ready = channelConfigReadyForExecution(broker, 'channel-b')
  assert.equal(ready.ready, true)
  const resolved = resolveChannelTradingConfig(broker, 'channel-b')
  assert.equal(resolved.manual_settings.fixed_lot, 0.01)
  assert.equal(resolved.manual_settings.trade_style, 'single')
})

test('linked channel missing config falls back to defaults when broker manual_settings incomplete', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: {},
    channel_trading_configs: {},
    signal_channel_ids: ['channel-a', 'channel-b'],
  }
  const ready = channelConfigReadyForExecution(broker, 'channel-b')
  assert.equal(ready.ready, true)
  const resolved = resolveChannelTradingConfig(broker, 'channel-b')
  assert.equal(resolved.manual_settings.fixed_lot, 0.01)
  assert.equal(resolved.manual_settings.trade_style, 'single')
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
    manual_settings: { fixed_lot: 0.05, trade_style: 'single', add_new_trades_to_existing: false },
    ai_settings: {},
    channel_trading_configs: {
      'ch-a': { copier_mode: 'manual' as const, manual_settings: { fixed_lot: 0.02, trade_style: 'multi', add_new_trades_to_existing: true } },
      'ch-b': { copier_mode: 'manual' as const, manual_settings: { fixed_lot: 0.08, trade_style: 'single' } },
    },
    signal_channel_ids: ['ch-a', 'ch-b'],
  }
  const a = resolveChannelTradingConfig(broker, 'ch-a')
  const b = resolveChannelTradingConfig(broker, 'ch-b')
  assert.equal(a.manual_settings.trade_style, 'multi')
  assert.equal(a.manual_settings.fixed_lot, 0.02)
  assert.equal(a.manual_settings.add_new_trades_to_existing, true)
  assert.equal(a.config_source, 'per_channel')
  assert.equal(b.manual_settings.fixed_lot, 0.08)
  assert.equal(b.manual_settings.add_new_trades_to_existing, true)
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

test('withChannelTradingConfig: channel symbol mapping beats account symbol mapping', () => {
  const broker = {
    id: 'b1',
    copier_mode: 'manual' as const,
    manual_settings: {
      fixed_lot: 0.05,
      trade_style: 'single',
      symbol_mapping: { NAS100: 'US100' },
    },
    channel_trading_configs: {
      ch1: {
        manual_settings: {
          fixed_lot: 0.11,
          trade_style: 'single',
          symbol_mapping: { NAS100: 'USTEC' },
        },
      },
    },
    signal_channel_ids: ['ch1'],
  }
  const effective = withChannelTradingConfig(broker, 'ch1')
  const mapped = applySymbolMapping('NAS100', effective as never)
  assert.equal(mapped.symbol, 'USTEC')
  assert.equal(mapped.userDecorated, true)
})

test('buildDefaultChannelTradingConfig seeds manual defaults', () => {
  const cfg = buildDefaultChannelTradingConfig()
  assert.equal(cfg.copier_mode, 'manual')
  assert.equal(cfg.manual_settings?.trade_style, 'single')
  assert.equal(cfg.manual_settings?.fixed_lot, 0.01)
})

test('multi-channel migration seed does not inherit broker manual_settings from another channel', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'multi', risk_mode: 'fixed_lot', schema_version: 1 },
    channel_trading_configs: {
      'signal-tester': {
        copier_mode: 'manual' as const,
        manual_settings: { fixed_lot: 0.01, trade_style: 'single', risk_mode: 'fixed_lot' },
      },
      'other-ch': {
        copier_mode: 'manual' as const,
        manual_settings: { fixed_lot: 0.01, trade_style: 'single', risk_mode: 'fixed_lot' },
      },
    },
    signal_channel_ids: ['signal-tester', 'other-ch'],
  }
  const resolved = resolveChannelTradingConfig(broker, 'signal-tester')
  assert.equal(resolved.manual_settings.fixed_lot, 0.01)
  assert.equal(resolved.manual_settings.trade_style, 'single')
  assert.equal(resolved.config_source, 'per_channel')
})

test('single-channel migration seed still heals from broker manual_settings', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'multi', risk_mode: 'fixed_lot', schema_version: 1 },
    channel_trading_configs: {
      'signal-tester': {
        copier_mode: 'manual' as const,
        manual_settings: { fixed_lot: 0.01, trade_style: 'single', risk_mode: 'fixed_lot' },
      },
    },
    signal_channel_ids: ['signal-tester'],
  }
  const resolved = resolveChannelTradingConfig(broker, 'signal-tester')
  assert.equal(resolved.manual_settings.fixed_lot, 0.05)
  assert.equal(resolved.manual_settings.trade_style, 'multi')
})

test('linked channel with full per-channel save keeps its own lot and style', () => {
  const broker = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single', schema_version: 1 },
    channel_trading_configs: {
      'signal-tester': {
        copier_mode: 'manual' as const,
        manual_settings: {
          schema_version: 1,
          fixed_lot: 0.03,
          trade_style: 'single',
          risk_mode: 'fixed_lot',
          tp_lots: [],
        },
      },
    },
    signal_channel_ids: ['signal-tester'],
  }
  const resolved = resolveChannelTradingConfig(broker, 'signal-tester')
  assert.equal(resolved.manual_settings.fixed_lot, 0.03)
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

test('healedConfigPersistDiffers ignores key order and copy_limit_state', () => {
  const stored = {
    copier_mode: 'manual' as const,
    manual_settings: { fixed_lot: 0.05, trade_style: 'single', nested: { a: 1, b: 2 } },
    ai_settings: { x: 1 },
  }
  const same = {
    copier_mode: 'manual' as const,
    manual_settings: { nested: { b: 2, a: 1 }, trade_style: 'single', fixed_lot: 0.05 },
    ai_settings: { x: 1 },
  }
  assert.equal(healedConfigPersistDiffers(stored, same), false)
  assert.equal(
    healedConfigPersistDiffers(stored, { ...same, manual_settings: { ...same.manual_settings, fixed_lot: 0.06 } }),
    true,
  )
  assert.equal(healedConfigPersistDiffers(undefined, same), true)
  assert.equal(
    healedConfigPersistDiffers(
      { ...stored, copy_limit_state: { paused: true } } as never,
      { ...same, copy_limit_state: { paused: false } } as never,
    ),
    false,
  )
})

test('healPersistWithinCooldown blocks repeats inside the window and recovers after', () => {
  resetHealPersistCooldownsForTests()
  const key = 'user|broker|channel'
  assert.equal(healPersistWithinCooldown(key, 1000, 60_000), false)
  assert.equal(healPersistWithinCooldown(key, 60_000, 60_000), true)
  assert.equal(healPersistWithinCooldown(key, 61_001, 60_000), false)
  assert.equal(healPersistWithinCooldown('other|broker|channel', 61_002, 60_000), false)
  resetHealPersistCooldownsForTests()
  assert.equal(healPersistWithinCooldown(key, 61_003, 60_000), false)
})

test('persistHealedChannelConfigs never rewrites identical content and respects cooldown', async () => {
  resetHealPersistCooldownsForTests()
  const upserts: Array<Record<string, unknown>> = []
  const supabase = {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row)
        return { error: null }
      },
    }),
  }
  const storedManual = { fixed_lot: 0, trade_style: 'multi', risk_mode: 'dynamic', schema_version: 1 }
  const originalRaw = {
    'Chan-Nel': {
      copier_mode: 'manual',
      manual_settings: storedManual,
      ai_settings: {},
    },
  }
  // Identical healed content (the 2026-10-28 loop shape: incomplete row that can
  // never pass the completeness check) must produce zero writes.
  await persistHealedChannelConfigs(
    supabase as never,
    'user-1',
    'broker-1',
    originalRaw,
    {
      'chan-nel': {
        copier_mode: 'manual',
        manual_settings: { ...storedManual },
        ai_settings: {},
        copy_limit_state: null,
      },
    },
  )
  assert.equal(upserts.length, 0)

  // Changed content writes once; an immediate repeat is suppressed by cooldown.
  await persistHealedChannelConfigs(
    supabase as never,
    'user-1',
    'broker-1',
    originalRaw,
    {
      'chan-nel': {
        copier_mode: 'manual',
        manual_settings: { ...storedManual, fixed_lot: 0.01 },
        ai_settings: {},
        copy_limit_state: null,
      },
    },
  )
  assert.equal(upserts.length, 1)
  assert.equal((upserts[0]!.manual_settings as Record<string, unknown>).fixed_lot, 0.01)

  await persistHealedChannelConfigs(
    supabase as never,
    'user-1',
    'broker-1',
    originalRaw,
    {
      'chan-nel': {
        copier_mode: 'manual',
        manual_settings: { ...storedManual, fixed_lot: 0.02 },
        ai_settings: {},
        copy_limit_state: null,
      },
    },
  )
  assert.equal(upserts.length, 1)
  resetHealPersistCooldownsForTests()
})

test('persistHealedChannelConfigs skips a heal that is still incomplete even when content differs', async () => {
  resetHealPersistCooldownsForTests()
  const upserts: Array<Record<string, unknown>> = []
  const supabase = {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row)
        return { error: null }
      },
    }),
  }
  // Stored row is incomplete (fixed_lot 0) and the healed content DIFFERS
  // (trade_style changed) but is still incomplete — the heal cannot improve
  // anything, so it must not write (incident 2026-10-28 shape).
  const originalRaw = {
    'chan-nel': {
      copier_mode: 'manual',
      manual_settings: { fixed_lot: 0, trade_style: 'single', risk_mode: 'dynamic', schema_version: 1 },
      ai_settings: {},
    },
  }
  await persistHealedChannelConfigs(
    supabase as never,
    'user-1',
    'broker-1',
    originalRaw,
    {
      'chan-nel': {
        copier_mode: 'manual',
        manual_settings: { fixed_lot: 0, trade_style: 'multi', risk_mode: 'dynamic', schema_version: 1 },
        ai_settings: {},
        copy_limit_state: null,
      },
    },
  )
  assert.equal(upserts.length, 0)
  resetHealPersistCooldownsForTests()
})
