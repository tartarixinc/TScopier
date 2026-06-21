import { periodKeyFor, periodStorageKey, pruneExpiredPauseKeys } from './copyLimitPeriods'
import type {
  CopyLimitPeriod,
  CopyLimitState,
  CopyLimitsConfig,
  MaxRiskRule,
  ProfitTargetRule,
} from './copyLimitTypes'
import { pauseKey, ruleFingerprint } from './copyLimitTypes'

/** Account equity relative to period-start baseline. */
export type EquitySnapshot = {
  currentEquity: number
  periodStartEquity: number
  peakEquity: number
}

export type CopyLimitBreach = {
  kind: 'profit' | 'risk'
  reason: 'channel_profit_target_hit' | 'channel_max_risk_hit'
  pauseKey: string
  ruleId?: string
  /** Fingerprint of the breached rule, recorded so later config edits can clear the pause. */
  fingerprint?: string
}

export function resolveCopyLimitTimezone(
  config: CopyLimitsConfig,
  profileTimezone: string | null | undefined,
): string {
  if (config.timezone_mode === 'custom' && config.timezone?.trim()) {
    return config.timezone.trim()
  }
  return profileTimezone?.trim() || 'UTC'
}

export function copyLimitsActive(config: CopyLimitsConfig | null | undefined): boolean {
  if (!config) return false
  const profitOn = config.profit_targets_enabled
    && config.profit_targets.some(t => t.enabled && t.value > 0)
  const riskOn = config.max_risk_enabled
    && config.max_risks.some(t => t.enabled && t.value > 0)
  return profitOn || riskOn
}

export function equityDelta(equity: EquitySnapshot): number {
  return equity.currentEquity - equity.periodStartEquity
}

function profitTargetHit(
  rule: ProfitTargetRule,
  equity: EquitySnapshot,
  channelPnl?: number | null,
): boolean {
  if (!rule.enabled || rule.value <= 0) return false
  const delta = equityDelta(equity)
  if (rule.value_type === 'amount') {
    if (delta >= rule.value) return true
    return channelPnl != null && channelPnl >= rule.value
  }
  if (equity.periodStartEquity <= 0) return false
  if ((delta / equity.periodStartEquity) * 100 >= rule.value) return true
  return channelPnl != null
    && (channelPnl / equity.periodStartEquity) * 100 >= rule.value
}

function maxRiskHit(
  rule: MaxRiskRule,
  equity: EquitySnapshot,
  channelPnl?: number | null,
): boolean {
  if (!rule.enabled || rule.value <= 0) return false
  const delta = equityDelta(equity)
  if (rule.value_type === 'amount') {
    if (delta <= -rule.value) return true
    return channelPnl != null && channelPnl <= -rule.value
  }
  if (equity.periodStartEquity <= 0) return false
  const drawdown = Math.max(0, equity.peakEquity - equity.currentEquity)
  if ((drawdown / equity.periodStartEquity) * 100 >= rule.value) return true
  return channelPnl != null
    && channelPnl < 0
    && (-channelPnl / equity.periodStartEquity) * 100 >= rule.value
}

export function evaluateCopyLimitBreaches(args: {
  config: CopyLimitsConfig
  state: CopyLimitState
  equity: EquitySnapshot
  timeZone: string
  at?: Date
  /**
   * Channel-scoped period P/L (realized + live floating). Secondary trigger:
   * fires the limit even when the account-equity delta is skewed by earlier
   * losses, other channels, or a stale equity read.
   */
  channelPnl?: number | null
}): CopyLimitBreach[] {
  const at = args.at ?? new Date()
  const breaches: CopyLimitBreach[] = []

  if (args.config.profit_targets_enabled) {
    for (const rule of args.config.profit_targets) {
      if (!profitTargetHit(rule, args.equity, args.channelPnl)) continue
      const pk = periodKeyFor(rule.period, args.timeZone, at)
      breaches.push({
        kind: 'profit',
        reason: 'channel_profit_target_hit',
        pauseKey: pauseKey('profit', rule.period, pk, rule.id),
        ruleId: rule.id,
        fingerprint: ruleFingerprint(rule),
      })
    }
  }

  if (args.config.max_risk_enabled) {
    for (const rule of args.config.max_risks) {
      if (!maxRiskHit(rule, args.equity, args.channelPnl)) continue
      const pk = periodKeyFor(rule.period, args.timeZone, at)
      breaches.push({
        kind: 'risk',
        reason: 'channel_max_risk_hit',
        pauseKey: pauseKey('risk', rule.period, pk, rule.id),
        ruleId: rule.id,
        fingerprint: ruleFingerprint(rule),
      })
    }
  }

  return breaches
}

export function updatePeriodSnapshots(args: {
  state: CopyLimitState
  config: CopyLimitsConfig
  currentEquity: number
  timeZone: string
  at?: Date
}): CopyLimitState {
  const at = args.at ?? new Date()
  const periods = { ...args.state.periods }
  const periodKinds: CopyLimitPeriod[] = ['daily', 'weekly', 'monthly', 'overall']

  const touchPeriod = (period: CopyLimitPeriod) => {
    const pk = periodKeyFor(period, args.timeZone, at)
    const storageKey = periodStorageKey(period, pk)
    const prev = periods[storageKey]
    const periodStart = prev?.reference_equity && prev.reference_equity > 0
      ? prev.reference_equity
      : args.currentEquity
    const peak = Math.max(prev?.peak_equity ?? args.currentEquity, args.currentEquity)
    periods[storageKey] = {
      period_key: pk,
      reference_equity: periodStart,
      peak_equity: peak,
      last_evaluated_at: at.toISOString(),
    }
  }

  if (args.config.profit_targets_enabled) {
    for (const rule of args.config.profit_targets) {
      if (rule.enabled) touchPeriod(rule.period)
    }
  }
  if (args.config.max_risk_enabled) {
    for (const rule of args.config.max_risks) {
      if (rule.enabled) touchPeriod(rule.period)
    }
  }

  for (const period of periodKinds) {
    const pk = periodKeyFor(period, args.timeZone, at)
    const storageKey = periodStorageKey(period, pk)
    if (!periods[storageKey]) continue
    const currentPk = periods[storageKey]?.period_key
    if (currentPk && currentPk !== pk) {
      delete periods[storageKey]
    }
  }

  const paused_period_keys = pruneExpiredPauseKeys(args.state.paused_period_keys, args.timeZone, at)
  const flattened_pause_keys = pruneExpiredPauseKeys(args.state.flattened_pause_keys ?? [], args.timeZone, at)
  const pause_rule_fingerprints = pickFingerprints(
    args.state.pause_rule_fingerprints,
    new Set([...paused_period_keys, ...flattened_pause_keys]),
  )

  return { paused_period_keys, flattened_pause_keys, pause_rule_fingerprints, periods }
}

function pickFingerprints(
  fingerprints: Record<string, string> | undefined,
  keys: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, fp] of Object.entries(fingerprints ?? {})) {
    if (keys.has(key)) out[key] = fp
  }
  return out
}

export function mergeBreachesIntoState(
  state: CopyLimitState,
  breaches: CopyLimitBreach[],
): CopyLimitState {
  const set = new Set(state.paused_period_keys)
  const fingerprints = { ...(state.pause_rule_fingerprints ?? {}) }
  for (const b of breaches) {
    set.add(b.pauseKey)
    if (b.fingerprint) fingerprints[b.pauseKey] = b.fingerprint
  }
  return { ...state, paused_period_keys: [...set], pause_rule_fingerprints: fingerprints }
}

function ruleForPauseKey(
  config: CopyLimitsConfig,
  key: string,
): ProfitTargetRule | MaxRiskRule | null {
  const parts = key.split(':')
  const kind = parts[0]
  const period = parts[1]
  if (!kind || !period) return null
  const list = kind === 'risk'
    ? (config.max_risk_enabled ? config.max_risks : [])
    : (config.profit_targets_enabled ? config.profit_targets : [])
  const ruleId = period === 'overall' ? parts[2] : parts[3]
  const rule = ruleId
    ? list.find(r => r.id === ruleId)
    : list.find(r => r.period === period && r.enabled)
  if (!rule || !rule.enabled || rule.value <= 0) return null
  return rule
}

/**
 * Drop pause keys that no longer correspond to the current config:
 *   - the rule (or its whole section) was deleted or disabled, or
 *   - the rule's thresholds changed since the breach (fingerprint mismatch) —
 *     e.g. the user raised the profit target / max loss, or
 *   - legacy pauses without a recorded fingerprint, when `currentBreachKeys`
 *     is provided (worker path with live equity) and the rule is not
 *     currently breaching.
 *
 * Pauses for unchanged, still-valid rules stay sticky until the period resets.
 */
export function reconcilePausedKeysWithConfig(
  state: CopyLimitState,
  config: CopyLimitsConfig,
  currentBreachKeys?: Set<string> | null,
): CopyLimitState {
  const fingerprints = state.pause_rule_fingerprints ?? {}
  const kept = state.paused_period_keys.filter(key => {
    const rule = ruleForPauseKey(config, key)
    if (!rule) return false
    const recorded = fingerprints[key]
    if (recorded) return recorded === ruleFingerprint(rule)
    if (currentBreachKeys) return currentBreachKeys.has(key)
    return true
  })
  if (kept.length === state.paused_period_keys.length) return state

  const keptSet = new Set(kept)
  return {
    ...state,
    paused_period_keys: kept,
    flattened_pause_keys: (state.flattened_pause_keys ?? []).filter(k => keptSet.has(k)),
    pause_rule_fingerprints: pickFingerprints(state.pause_rule_fingerprints, keptSet),
  }
}

export function isChannelCopyLimitPaused(args: {
  config: CopyLimitsConfig | null | undefined
  state: CopyLimitState | null | undefined
  timeZone: string
  at?: Date
}): CopyLimitBreach | null {
  if (!copyLimitsActive(args.config)) return null
  const rawState = args.state ?? { paused_period_keys: [], periods: {} }
  // Ignore pauses from rules that were since edited/removed — e.g. the user
  // raised the profit target after it was hit.
  const state = reconcilePausedKeysWithConfig(rawState, args.config!)
  const at = args.at ?? new Date()
  const active = pruneExpiredPauseKeys(state.paused_period_keys, args.timeZone, at)
  if (!active.length) return null

  const key = active[0]!
  if (key.startsWith('risk:')) {
    return { kind: 'risk', reason: 'channel_max_risk_hit', pauseKey: key }
  }
  return { kind: 'profit', reason: 'channel_profit_target_hit', pauseKey: key }
}

export function periodEquitySnapshot(
  state: CopyLimitState,
  period: CopyLimitPeriod,
  currentEquity: number,
  timeZone: string,
  at = new Date(),
): EquitySnapshot {
  const pk = periodKeyFor(period, timeZone, at)
  const storageKey = periodStorageKey(period, pk)
  const snap = state.periods[storageKey]
  const periodStartEquity = snap?.reference_equity && snap.reference_equity > 0
    ? snap.reference_equity
    : currentEquity
  const peakEquity = Math.max(snap?.peak_equity ?? currentEquity, currentEquity)
  return { currentEquity, periodStartEquity, peakEquity }
}
