export type CopyLimitPeriod = 'daily' | 'weekly' | 'monthly' | 'overall'
export type CopyLimitValueType = 'amount' | 'percent'
export type CopyLimitTimezoneMode = 'profile' | 'custom'

export interface ProfitTargetRule {
  id: string
  enabled: boolean
  period: CopyLimitPeriod
  value_type: CopyLimitValueType
  value: number
}

export interface MaxRiskRule {
  id: string
  enabled: boolean
  period: CopyLimitPeriod
  value_type: CopyLimitValueType
  value: number
}

export interface CopyLimitsConfig {
  profit_targets_enabled: boolean
  profit_targets: ProfitTargetRule[]
  max_risk_enabled: boolean
  max_risks: MaxRiskRule[]
  timezone_mode: CopyLimitTimezoneMode
  timezone?: string
}

export interface CopyLimitPeriodSnapshot {
  period_key: string
  /** Account equity at period start (baseline for delta targets). */
  reference_equity: number
  /** Peak account equity seen during the period (drawdown reference). */
  peak_equity: number
  /** @deprecated Legacy channel P/L peak — migrated to peak_equity on read. */
  peak_channel_pnl?: number
  last_evaluated_at: string
}

export interface CopyLimitState {
  paused_period_keys: string[]
  /** Pause keys that already triggered an automatic channel flatten. */
  flattened_pause_keys?: string[]
  /**
   * pauseKey → fingerprint of the rule (period|type|value) at breach time.
   * Lets evaluation drop a pause when the user has since changed the rule
   * (e.g. raised the profit target), instead of staying paused until the
   * period resets.
   */
  pause_rule_fingerprints?: Record<string, string>
  periods: Record<string, CopyLimitPeriodSnapshot>
}

/** Identity of a rule's thresholds — changing any of these invalidates old pauses. */
export function ruleFingerprint(rule: {
  period: CopyLimitPeriod
  value_type: CopyLimitValueType
  value: number
}): string {
  return `${rule.period}|${rule.value_type}|${rule.value}`
}

export const DEFAULT_COPY_LIMITS: CopyLimitsConfig = {
  profit_targets_enabled: false,
  profit_targets: [],
  max_risk_enabled: false,
  max_risks: [],
  timezone_mode: 'profile',
}

export const DEFAULT_COPY_LIMIT_STATE: CopyLimitState = {
  paused_period_keys: [],
  periods: {},
}

export function normalizeCopyLimits(raw: unknown): CopyLimitsConfig {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const profitTargets = Array.isArray(j.profit_targets)
    ? j.profit_targets
      .map((row, idx) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
        const value = Number(r.value)
        const period = String(r.period ?? 'daily')
        const valueType = String(r.value_type ?? 'amount')
        const validPeriod = ['daily', 'weekly', 'monthly', 'overall'].includes(period)
          ? (period as CopyLimitPeriod)
          : 'daily'
        const validType = valueType === 'percent' ? 'percent' : 'amount'
        return {
          id: String(r.id ?? `pt-${idx}`),
          enabled: r.enabled !== false,
          period: validPeriod,
          value_type: validType,
          value: Number.isFinite(value) && value > 0 ? value : 0,
        } satisfies ProfitTargetRule
      })
      .filter(r => r.value > 0)
    : []

  const parseMaxRiskRow = (row: unknown, idx: number): MaxRiskRule => {
    const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    const value = Number(r.value)
    const period = String(r.period ?? 'daily')
    const valueType = String(r.value_type ?? 'amount')
    const validPeriod = ['daily', 'weekly', 'monthly', 'overall'].includes(period)
      ? (period as CopyLimitPeriod)
      : 'daily'
    const validType = valueType === 'percent' ? 'percent' : 'amount'
    return {
      id: String(r.id ?? `mr-${idx}`),
      enabled: r.enabled !== false,
      period: validPeriod,
      value_type: validType,
      value: Number.isFinite(value) && value > 0 ? value : 0,
    }
  }

  let maxRisks = Array.isArray(j.max_risks)
    ? j.max_risks.map((row, idx) => parseMaxRiskRow(row, idx)).filter(r => r.value > 0)
    : []

  if (!maxRisks.length && j.max_risk && typeof j.max_risk === 'object') {
    const legacy = parseMaxRiskRow(j.max_risk, 0)
    if (legacy.value > 0) {
      maxRisks = [{ ...legacy, id: legacy.id === 'mr-0' ? 'mr-legacy' : legacy.id }]
    }
  }

  const tzMode = String(j.timezone_mode ?? 'profile')
  return {
    profit_targets_enabled: j.profit_targets_enabled === true,
    profit_targets: profitTargets,
    max_risk_enabled: j.max_risk_enabled === true && maxRisks.length > 0,
    max_risks: maxRisks,
    timezone_mode: tzMode === 'custom' ? 'custom' : 'profile',
    timezone: typeof j.timezone === 'string' && j.timezone.trim() ? j.timezone.trim() : undefined,
  }
}

export function normalizeCopyLimitState(raw: unknown): CopyLimitState {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const paused = Array.isArray(j.paused_period_keys)
    ? j.paused_period_keys.map(k => String(k)).filter(Boolean)
    : []
  const periods: Record<string, CopyLimitPeriodSnapshot> = {}
  if (j.periods && typeof j.periods === 'object') {
    for (const [key, val] of Object.entries(j.periods as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue
      const row = val as Record<string, unknown>
      const ref = Number(row.reference_equity)
      const peakEquity = Number(row.peak_equity)
      const legacyPeakPnl = Number(row.peak_channel_pnl)
      const peak = Number.isFinite(peakEquity) && peakEquity > 0
        ? peakEquity
        : (Number.isFinite(legacyPeakPnl) && legacyPeakPnl > 0 ? legacyPeakPnl : ref)
      periods[key] = {
        period_key: String(row.period_key ?? key),
        reference_equity: Number.isFinite(ref) ? ref : 0,
        peak_equity: Number.isFinite(peak) ? peak : 0,
        last_evaluated_at: String(row.last_evaluated_at ?? ''),
      }
    }
  }
  const flattened = Array.isArray(j.flattened_pause_keys)
    ? j.flattened_pause_keys.map(k => String(k)).filter(Boolean)
    : []
  const fingerprints: Record<string, string> = {}
  if (j.pause_rule_fingerprints && typeof j.pause_rule_fingerprints === 'object') {
    for (const [key, val] of Object.entries(j.pause_rule_fingerprints as Record<string, unknown>)) {
      if (typeof val === 'string' && val) fingerprints[key] = val
    }
  }
  return {
    paused_period_keys: paused,
    flattened_pause_keys: flattened,
    pause_rule_fingerprints: fingerprints,
    periods,
  }
}

export function pauseKey(kind: 'profit' | 'risk', period: CopyLimitPeriod, periodKey: string, ruleId?: string): string {
  if (period === 'overall') {
    return ruleId ? `${kind}:overall:${ruleId}` : `${kind}:overall`
  }
  return `${kind}:${period}:${periodKey}${ruleId ? `:${ruleId}` : ''}`
}
