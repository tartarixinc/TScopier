import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateCopyLimitBreaches,
  equityDelta,
  isChannelCopyLimitPaused,
  reconcilePausedKeysWithConfig,
} from './copyLimitEvaluate'
import { DEFAULT_COPY_LIMITS, pauseKey, ruleFingerprint } from './copyLimitTypes'
import { periodKeyFor } from './copyLimitPeriods'

describe('copyLimitEvaluate', () => {
  it('detects profit target hit when equity gains reach amount target', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [{
        id: 't1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 1000,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 11_000,
        periodStartEquity: 10_000,
        peakEquity: 11_000,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.reason, 'channel_profit_target_hit')
    assert.equal(equityDelta({
      currentEquity: 11_000,
      periodStartEquity: 10_000,
      peakEquity: 11_000,
    }), 1000)
  })

  it('detects max loss hit when equity drops by amount limit', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [{
        id: 'r1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 500,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 9_400,
        periodStartEquity: 10_000,
        peakEquity: 10_200,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.reason, 'channel_max_risk_hit')
    assert.equal(breaches[0]!.ruleId, 'r1')
  })

  it('evaluates multiple max risk rules independently', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [
        {
          id: 'r-daily',
          enabled: true,
          period: 'daily' as const,
          value_type: 'amount' as const,
          value: 50,
        },
        {
          id: 'r-weekly',
          enabled: true,
          period: 'weekly' as const,
          value_type: 'percent' as const,
          value: 5,
        },
      ],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 9_940,
        periodStartEquity: 10_000,
        peakEquity: 10_200,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.ruleId, 'r-daily')
  })

  it('detects max risk percent from peak equity drawdown', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [{
        id: 'r-pct',
        enabled: true,
        period: 'daily' as const,
        value_type: 'percent' as const,
        value: 2,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 10_500,
        periodStartEquity: 10_000,
        peakEquity: 10_800,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.ruleId, 'r-pct')
  })

  it('reports paused when active pause key matches period', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [{
        id: 't1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 50,
      }],
    }
    const pause = isChannelCopyLimitPaused({
      config,
      state: { paused_period_keys: [pauseKey('profit', 'daily', pk, 't1')], periods: {} },
      timeZone: 'UTC',
      at,
    })
    assert.ok(pause)
    assert.equal(pause!.reason, 'channel_profit_target_hit')
  })

  it('clears the pause when the user raises the profit target', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const oldRule = {
      id: 't1',
      enabled: true,
      period: 'daily' as const,
      value_type: 'amount' as const,
      value: 1000,
    }
    const key = pauseKey('profit', 'daily', pk, 't1')
    // Paused at $1000, then the user raises the target to $5000.
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [{ ...oldRule, value: 5000 }],
    }
    const pause = isChannelCopyLimitPaused({
      config,
      state: {
        paused_period_keys: [key],
        pause_rule_fingerprints: { [key]: ruleFingerprint(oldRule) },
        periods: {},
      },
      timeZone: 'UTC',
      at,
    })
    assert.equal(pause, null)
  })

  it('clears the pause when the user raises the max loss', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const oldRule = {
      id: 'r1',
      enabled: true,
      period: 'daily' as const,
      value_type: 'amount' as const,
      value: 500,
    }
    const key = pauseKey('risk', 'daily', pk, 'r1')
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [{ ...oldRule, value: 2000 }],
    }
    const pause = isChannelCopyLimitPaused({
      config,
      state: {
        paused_period_keys: [key],
        pause_rule_fingerprints: { [key]: ruleFingerprint(oldRule) },
        periods: {},
      },
      timeZone: 'UTC',
      at,
    })
    assert.equal(pause, null)
  })

  it('keeps the pause when the rule is unchanged', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const rule = {
      id: 't1',
      enabled: true,
      period: 'daily' as const,
      value_type: 'amount' as const,
      value: 1000,
    }
    const key = pauseKey('profit', 'daily', pk, 't1')
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [rule],
    }
    const pause = isChannelCopyLimitPaused({
      config,
      state: {
        paused_period_keys: [key],
        pause_rule_fingerprints: { [key]: ruleFingerprint(rule) },
        periods: {},
      },
      timeZone: 'UTC',
      at,
    })
    assert.ok(pause)
  })

  it('clears the pause when the rule is deleted or disabled', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const key = pauseKey('profit', 'daily', pk, 't1')
    const state = {
      paused_period_keys: [key],
      periods: {},
    }
    const otherRule = {
      id: 't2',
      enabled: true,
      period: 'weekly' as const,
      value_type: 'amount' as const,
      value: 100,
    }
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [otherRule],
    }
    assert.equal(isChannelCopyLimitPaused({ config, state, timeZone: 'UTC', at }), null)
  })

  describe('reconcilePausedKeysWithConfig', () => {
    const at = new Date('2026-06-08T12:00:00Z')
    const pk = periodKeyFor('daily', 'UTC', at)
    const rule = {
      id: 't1',
      enabled: true,
      period: 'daily' as const,
      value_type: 'amount' as const,
      value: 1000,
    }
    const key = pauseKey('profit', 'daily', pk, 't1')
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [rule],
    }

    it('keeps legacy un-fingerprinted pauses that still breach', () => {
      const next = reconcilePausedKeysWithConfig(
        { paused_period_keys: [key], flattened_pause_keys: [key], periods: {} },
        config,
        new Set([key]),
      )
      assert.deepEqual(next.paused_period_keys, [key])
      assert.deepEqual(next.flattened_pause_keys, [key])
    })

    it('drops legacy un-fingerprinted pauses that no longer breach', () => {
      const next = reconcilePausedKeysWithConfig(
        { paused_period_keys: [key], flattened_pause_keys: [key], periods: {} },
        config,
        new Set<string>(),
      )
      assert.deepEqual(next.paused_period_keys, [])
      assert.deepEqual(next.flattened_pause_keys, [])
    })

    it('keeps legacy pauses when no live breach info is available', () => {
      const next = reconcilePausedKeysWithConfig(
        { paused_period_keys: [key], periods: {} },
        config,
      )
      assert.deepEqual(next.paused_period_keys, [key])
    })

    it('drops the flatten marker together with a fingerprint-mismatched pause', () => {
      const next = reconcilePausedKeysWithConfig(
        {
          paused_period_keys: [key],
          flattened_pause_keys: [key],
          pause_rule_fingerprints: { [key]: ruleFingerprint({ ...rule, value: 500 }) },
          periods: {},
        },
        config,
        new Set([key]),
      )
      assert.deepEqual(next.paused_period_keys, [])
      assert.deepEqual(next.flattened_pause_keys, [])
      assert.deepEqual(next.pause_rule_fingerprints, {})
    })
  })
})

describe('copyLimitEvaluate channelPnl secondary trigger', () => {
  const profitConfig = {
    ...DEFAULT_COPY_LIMITS,
    profit_targets_enabled: true,
    profit_targets: [{
      id: 't1',
      enabled: true,
      period: 'daily' as const,
      value_type: 'amount' as const,
      value: 1000,
    }],
  }

  it('fires profit target from channel floating P/L when equity delta lags', () => {
    // Equity read is stale (delta 0) but the channel's open trades are +1045.
    const breaches = evaluateCopyLimitBreaches({
      config: profitConfig,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 49_580,
        periodStartEquity: 49_580,
        peakEquity: 49_580,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-10T04:28:00Z'),
      channelPnl: 1_045.95,
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.reason, 'channel_profit_target_hit')
  })

  it('does not fire when neither equity delta nor channel P/L reach the target', () => {
    const breaches = evaluateCopyLimitBreaches({
      config: profitConfig,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 49_900,
        periodStartEquity: 49_580,
        peakEquity: 49_900,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-10T04:28:00Z'),
      channelPnl: 700,
    })
    assert.equal(breaches.length, 0)
  })

  it('fires max risk from channel P/L losses', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [{
        id: 'r1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 500,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      equity: {
        currentEquity: 10_000,
        periodStartEquity: 10_000,
        peakEquity: 10_000,
      },
      timeZone: 'UTC',
      at: new Date('2026-06-10T04:28:00Z'),
      channelPnl: -520,
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.reason, 'channel_max_risk_hit')
  })
})
