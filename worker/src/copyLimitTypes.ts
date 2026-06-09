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
  reference_equity: number
  peak_channel_pnl: number
  last_evaluated_at: string
}

export interface CopyLimitState {
  paused_period_keys: string[]
  /** Pause keys that already triggered an automatic channel flatten. */
  flattened_pause_keys?: string[]
  periods: Record<string, CopyLimitPeriodSnapshot>
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
      const peak = Number(row.peak_channel_pnl)
      periods[key] = {
        period_key: String(row.period_key ?? key),
        reference_equity: Number.isFinite(ref) ? ref : 0,
        peak_channel_pnl: Number.isFinite(peak) ? peak : 0,
        last_evaluated_at: String(row.last_evaluated_at ?? ''),
      }
    }
  }
  const flattened = Array.isArray(j.flattened_pause_keys)
    ? j.flattened_pause_keys.map(k => String(k)).filter(Boolean)
    : []
  return { paused_period_keys: paused, flattened_pause_keys: flattened, periods }
}

export function pauseKey(kind: 'profit' | 'risk', period: CopyLimitPeriod, periodKey: string, ruleId?: string): string {
  if (period === 'overall') {
    return ruleId ? `${kind}:overall:${ruleId}` : `${kind}:overall`
  }
  return `${kind}:${period}:${periodKey}${ruleId ? `:${ruleId}` : ''}`
}
