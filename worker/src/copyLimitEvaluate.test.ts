import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateCopyLimitBreaches,
  isChannelCopyLimitPaused,
} from './copyLimitEvaluate'
import { DEFAULT_COPY_LIMITS, pauseKey } from './copyLimitTypes'
import { periodKeyFor } from './copyLimitPeriods'

describe('copyLimitEvaluate', () => {
  it('detects profit target hit in amount mode', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      profit_targets_enabled: true,
      profit_targets: [{
        id: 't1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 100,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      pnl: { realizedPnl: 80, floatingPnl: 25, totalPnl: 105 },
      referenceEquity: 10_000,
      peakChannelPnl: 105,
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.reason, 'channel_profit_target_hit')
  })

  it('detects max risk hit in amount mode', () => {
    const config = {
      ...DEFAULT_COPY_LIMITS,
      max_risk_enabled: true,
      max_risks: [{
        id: 'r1',
        enabled: true,
        period: 'daily' as const,
        value_type: 'amount' as const,
        value: 50,
      }],
    }
    const breaches = evaluateCopyLimitBreaches({
      config,
      state: { paused_period_keys: [], periods: {} },
      pnl: { realizedPnl: -40, floatingPnl: -15, totalPnl: -55 },
      referenceEquity: 10_000,
      peakChannelPnl: 0,
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
      pnl: { realizedPnl: -60, floatingPnl: 0, totalPnl: -60 },
      referenceEquity: 10_000,
      peakChannelPnl: 20,
      timeZone: 'UTC',
      at: new Date('2026-06-08T12:00:00Z'),
    })
    assert.equal(breaches.length, 1)
    assert.equal(breaches[0]!.ruleId, 'r-daily')
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
})
