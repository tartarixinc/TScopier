import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCopyRiskPreset, DEFAULT_COPY_RISK, normalizeCopyRisk, type CopyRiskSettings } from './copyRiskTypes'
import {
  evaluateCopyAdmission,
  resolveCopyStops,
  sizeCopyLot,
  type CopyRiskAccountSnapshot,
  type CopyRiskOpenPosition,
  type CopyRiskProviderState,
  type CopyRiskTradeInput,
} from './copyRiskEvaluate'
import { COPIER_SKIP_REASON_LABELS } from './copierSkipReasonLabels'
import { COPY_RISK_REASON_LABELS, COPY_RISK_REASONS, copyRiskLogEvent } from './copyRiskReasons'

function account(patch: Partial<CopyRiskAccountSnapshot> = {}): CopyRiskAccountSnapshot {
  return {
    balance: 10_000,
    equity: 10_000,
    peakEquity: 10_000,
    balanceReference: 10_000,
    dayStartEquity: 10_000,
    weekStartEquity: 10_000,
    monthStartEquity: 10_000,
    freeMargin: 8_000,
    marginUsedPercent: 10,
    floatingPnl: 0,
    floatingPeakProfit: 0,
    consecutiveLosses: 0,
    connected: true,
    disconnectedSeconds: 0,
    tradingDisabled: false,
    accountLocked: false,
    quotesAgeSeconds: 1,
    equityAgeSeconds: 1,
    protectionLatched: false,
    ...patch,
  }
}

function provider(patch: Partial<CopyRiskProviderState> = {}): CopyRiskProviderState {
  return {
    id: 'master-1',
    suspended: false,
    allowFollowing: true,
    balance: 10_000,
    equity: 10_000,
    loss: 0,
    drawdownPercent: 0,
    openPositions: 0,
    openLots: 0,
    dailyTrades: 0,
    consecutiveLosses: 0,
    executionFailures: 0,
    slippageBreaches: 0,
    ...patch,
  }
}

function trade(patch: Partial<CopyRiskTradeInput> = {}): CopyRiskTradeInput {
  return {
    ticket: '1001',
    symbol: 'EURUSD',
    mappedSymbol: 'EURUSD',
    direction: 'buy',
    orderType: 'market',
    lots: 0.1,
    stopPips: 20,
    targetPips: 40,
    spreadPoints: 8,
    ageSeconds: 1,
    positionAgeSeconds: 1,
    priceMovePoints: 0,
    deviationPoints: 0,
    latencySeconds: 1,
    alreadyCopied: false,
    isCopy: false,
    snapshotAgeSeconds: 1,
    contractSizeRatio: 1,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 50,
    pipValuePerLot: 10,
    quoteToAccountRate: 1,
    estimatedMargin: 100,
    secondsSinceLastCopy: null,
    copiesInPeriod: 0,
    slModificationCount: 0,
    proposedStopWider: false,
    existingStopPips: null,
    ...patch,
  }
}

function risk(patch: Partial<CopyRiskSettings> = {}): CopyRiskSettings {
  return normalizeCopyRisk({
    ...DEFAULT_COPY_RISK,
    ...patch,
    sizing: { ...DEFAULT_COPY_RISK.sizing, ...patch.sizing },
    protection: { ...DEFAULT_COPY_RISK.protection, ...patch.protection },
    exposure: { ...DEFAULT_COPY_RISK.exposure, ...patch.exposure },
    stops: { ...DEFAULT_COPY_RISK.stops, ...patch.stops },
    filters: { ...DEFAULT_COPY_RISK.filters, ...patch.filters },
    execution: { ...DEFAULT_COPY_RISK.execution, ...patch.execution },
    provider: { ...DEFAULT_COPY_RISK.provider, ...patch.provider },
    advanced: { ...DEFAULT_COPY_RISK.advanced, ...patch.advanced },
    lifecycle: { ...DEFAULT_COPY_RISK.lifecycle, ...patch.lifecycle },
  })
}

test('lot multiplier doubles volume and is not the risk multiplier', () => {
  const profile = risk({
    sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'lot_multiplier', lot_multiplier: 2 },
    provider: { ...DEFAULT_COPY_RISK.provider, risk_multiplier: 1 },
  })
  const sized = sizeCopyLot(profile, account(), trade({ lots: 0.1, stopPips: 50 }), provider(), 50)
  assert.equal(sized.lot, 0.2)

  const monetary = risk({
    sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'percent_risk', percent_risk: 1, lot_multiplier: 5 },
    provider: { ...DEFAULT_COPY_RISK.provider, risk_multiplier: 2 },
  })
  const wide = sizeCopyLot(monetary, account(), trade({ stopPips: 40 }), provider(), 40)
  const tight = sizeCopyLot(monetary, account(), trade({ stopPips: 20 }), provider(), 20)
  assert.equal(tight.lot, 1)
  assert.equal(wide.lot, 0.5)
})

test('balance ratio scales by balances and falls back when source balance is missing', () => {
  const profile = risk({
    sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'balance_ratio', balance_multiplier: 1, fixed_lot: 0.01 },
  })
  const scaled = sizeCopyLot(
    profile,
    account({ balance: 5_000 }),
    trade({ lots: 1 }),
    provider({ balance: 10_000 }),
    20,
  )
  assert.equal(scaled.lot, 0.5)

  const missing = sizeCopyLot(profile, account(), trade({ lots: 1 }), provider({ balance: null }), 20)
  assert.equal(missing.lot, 0.01)
  assert.equal(missing.reason, 'copy_risk_missing_source_equity')
})

test('percent and cash risk skip when the trade has no stop', () => {
  const profile = risk({ sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'cash_risk', cash_risk: 20 } })
  const decision = evaluateCopyAdmission({
    risk: profile,
    trigger: 'trade',
    account: account(),
    positions: [],
    trade: trade({ stopPips: null, targetPips: null }),
    provider: provider(),
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'copy_risk_no_stop')
})

test('stop distance sizing gets smaller as the stop gets wider', () => {
  const profile = risk({
    sizing: {
      ...DEFAULT_COPY_RISK.sizing,
      mode: 'stop_distance',
      fixed_lot: 0.1,
      stop_distance_reference_pips: 20,
    },
  })
  const sized = sizeCopyLot(profile, account(), trade({ stopPips: 40 }), provider(), 40)
  assert.equal(sized.lot, 0.05)
})

test('account-wide exposure counts other providers and manual trades, then resizes', () => {
  const positions: CopyRiskOpenPosition[] = [
    { symbol: 'GBPUSD', direction: 'buy', lots: 1.2, pending: false, stopRiskCash: 50, providerId: 'other' },
    { symbol: 'USDJPY', direction: 'sell', lots: 0.8, pending: false, stopRiskCash: 40, providerId: null },
  ]
  const profile = risk({
    sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'fixed_lot', fixed_lot: 1 },
    exposure: { ...DEFAULT_COPY_RISK.exposure, max_total_lots: 2.5 },
  })
  const decision = evaluateCopyAdmission({
    risk: profile,
    trigger: 'trade',
    account: account(),
    positions,
    trade: trade(),
    provider: provider(),
  })
  assert.equal(decision.action, 'resize')
  assert.equal(decision.lot, 0.5)
  assert.equal(decision.reason, 'copy_risk_resized_exposure')
})

test('a full position cap skips the new order and does not close existing trades', () => {
  const positions: CopyRiskOpenPosition[] = [
    { symbol: 'EURUSD', direction: 'buy', lots: 0.1, pending: false, stopRiskCash: 10, providerId: null },
    { symbol: 'GBPUSD', direction: 'sell', lots: 0.1, pending: false, stopRiskCash: 10, providerId: 'other' },
  ]
  const decision = evaluateCopyAdmission({
    risk: risk({ exposure: { ...DEFAULT_COPY_RISK.exposure, max_open_positions: 2 } }),
    trigger: 'trade',
    account: account(),
    positions,
    trade: trade(),
    provider: provider(),
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'copy_risk_exposure')
})

test('stop precedence rejects a source stop outside the cap before force can replace it', () => {
  const profile = risk({
    stops: {
      ...DEFAULT_COPY_RISK.stops,
      force_sl: true,
      fixed_sl_pips: 15,
      max_sl_pips: 30,
      copy_source_sl: true,
    },
  })
  const rejected = resolveCopyStops(profile, trade({ stopPips: 100, targetPips: 200 }))
  assert.equal(rejected.reason, 'copy_risk_stop_distance')

  const copied = resolveCopyStops(
    risk({
      stops: {
        ...DEFAULT_COPY_RISK.stops,
        copy_source_sl: true,
        copy_source_tp: true,
        sl_multiplier: 2,
        sl_offset_pips: 1,
        tp_multiplier: 1,
        tp_offset_pips: -5,
      },
    }),
    trade({ stopPips: 10, targetPips: 30 }),
  )
  assert.equal(copied.stopPips, 21)
  assert.equal(copied.targetPips, 25)

  const forced = resolveCopyStops(
    risk({
      stops: {
        ...DEFAULT_COPY_RISK.stops,
        force_sl: true,
        force_tp: true,
        fixed_sl_pips: 12,
        fixed_tp_pips: 24,
        copy_source_sl: true,
      },
    }),
    trade({ stopPips: 10, targetPips: 30 }),
  )
  assert.equal(forced.stopPips, 12)
  assert.equal(forced.targetPips, 24)
})

test('never widen keeps the existing stop when a source move would increase loss', () => {
  const resolved = resolveCopyStops(
    risk({ stops: { ...DEFAULT_COPY_RISK.stops, never_widen_sl: true, copy_source_sl: true } }),
    trade({ stopPips: 40, existingStopPips: 20, proposedStopWider: true }),
  )
  assert.equal(resolved.stopPips, 20)
  assert.equal(resolved.reason, null)
})

test('protection actions pause, close, or close and pause', () => {
  const losing = account({ equity: 9_000, dayStartEquity: 10_000 })
  const pause = evaluateCopyAdmission({
    risk: risk({ protection: { ...DEFAULT_COPY_RISK.protection, max_daily_loss_cash: 500, daily_loss_value_type: 'cash', action: 'pause' } }),
    trigger: 'timer',
    account: losing,
    positions: [],
  })
  assert.equal(pause.action, 'pause')
  assert.equal(pause.reason, 'copy_risk_daily_loss')

  const close = evaluateCopyAdmission({
    risk: risk({ protection: { ...DEFAULT_COPY_RISK.protection, max_daily_loss_cash: 500, daily_loss_value_type: 'cash', action: 'close' } }),
    trigger: 'timer',
    account: losing,
    positions: [],
  })
  assert.equal(close.action, 'flatten')
  assert.equal(close.pause, false)

  const both = evaluateCopyAdmission({
    risk: risk({ protection: { ...DEFAULT_COPY_RISK.protection, max_daily_loss_cash: 500, daily_loss_value_type: 'cash', action: 'close_and_pause' } }),
    trigger: 'timer',
    account: losing,
    positions: [],
  })
  assert.equal(both.action, 'flatten')
  assert.equal(both.pause, true)
})

test('emergency stop flattens and the account lock only pauses', () => {
  const stopped = evaluateCopyAdmission({
    risk: risk({ protection: { ...DEFAULT_COPY_RISK.protection, emergency_stop: true } }),
    trigger: 'trade',
    account: account(),
    positions: [],
    trade: trade(),
  })
  assert.deepEqual(copyRiskLogEvent(stopped), {
    reason_code: 'copy_risk_emergency_stop',
    action: 'flatten',
    pause: true,
  })

  const locked = evaluateCopyAdmission({
    risk: risk({ lifecycle: { ...DEFAULT_COPY_RISK.lifecycle, account_locked: true } }),
    trigger: 'trade',
    account: account(),
    positions: [],
    trade: trade(),
  })
  assert.equal(locked.action, 'pause')
  assert.equal(locked.reason, 'copy_risk_emergency_lock')
  assert.ok(COPY_RISK_REASON_LABELS[locked.reason])
})

test('recovery mode stops multipliers from stepping up, and drawdown steps reduce size', () => {
  const profile = risk({
    sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'lot_multiplier', lot_multiplier: 3 },
    protection: { ...DEFAULT_COPY_RISK.protection, recovery_mode: true },
    advanced: {
      ...DEFAULT_COPY_RISK.advanced,
      drawdown_steps: [{ drawdown_percent: 5, lot_multiplier: 0.5 }],
    },
  })
  const recovered = sizeCopyLot(
    profile,
    account({ equity: 9_400, peakEquity: 10_000, consecutiveLosses: 2 }),
    trade({ lots: 0.1 }),
    provider(),
    20,
  )
  assert.equal(recovered.lot, 0.05)
})

test('already copied trades and copier comments are skipped', () => {
  const duplicate = evaluateCopyAdmission({
    risk: risk(),
    trigger: 'trade',
    account: account(),
    positions: [],
    trade: trade({ alreadyCopied: true }),
    provider: provider(),
  })
  assert.equal(duplicate.reason, 'copy_risk_duplicate')

  const copied = evaluateCopyAdmission({
    risk: risk(),
    trigger: 'trade',
    account: account(),
    positions: [],
    trade: trade({ isCopy: true, alreadyCopied: false }),
    provider: provider(),
  })
  assert.equal(copied.reason, 'copy_risk_already_a_copy')
})

test('quote currency conversion changes cash-risk lot size', () => {
  const profile = risk({ sizing: { ...DEFAULT_COPY_RISK.sizing, mode: 'cash_risk', cash_risk: 100 } })
  const converted = sizeCopyLot(
    profile,
    account(),
    trade({ quoteToAccountRate: 2, pipValuePerLot: 10, stopPips: 20 }),
    provider(),
    20,
  )
  assert.equal(converted.lot, 0.25)
})

test('copier log labels cover skip, resize, pause, flatten, and emergency lock', () => {
  const reasons = [
    'copy_risk_spread',
    'copy_risk_resized_exposure',
    'copy_risk_daily_loss',
    'copy_risk_emergency_stop',
    'copy_risk_emergency_lock',
  ] as const
  for (const reason of reasons) {
    assert.equal(COPIER_SKIP_REASON_LABELS[reason], COPY_RISK_REASON_LABELS[reason])
  }
  assert.equal(COPY_RISK_REASONS.includes('copy_risk_emergency_lock'), true)
  const resized = copyRiskLogEvent({ action: 'resize', reason: 'copy_risk_resized_lot' })
  assert.equal(resized.action, 'resize')
  const skipped = copyRiskLogEvent({ action: 'skip', reason: 'copy_risk_spread' })
  assert.equal(skipped.reason_code, 'copy_risk_spread')
})

test('presets write tighter limits for conservative than aggressive', () => {
  const conservative = applyCopyRiskPreset('conservative')
  const aggressive = applyCopyRiskPreset('aggressive')
  assert.equal(conservative.protection.max_drawdown_percent, 5)
  assert.equal(conservative.protection.action, 'close_and_pause')
  assert.equal(aggressive.protection.max_drawdown_percent, 20)
  assert.equal(aggressive.sizing.mode, 'lot_multiplier')
  assert.equal(conservative.filters.require_stop, true)
})
