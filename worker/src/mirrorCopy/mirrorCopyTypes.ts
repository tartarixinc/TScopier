/**
 * Mirror copy settings.
 *
 * The user's mirror configuration lives in broker_copy_links.manual_settings (jsonb).
 * The shape that the app already writes (see src/pages/dashboard/MirrorTradingPage.tsx
 * and src/lib/copyRiskTypes.ts) is:
 *
 *   {
 *     symbol_mapping: { EURUSD: "EURUSD.r", ... },
 *     copy_risk: CopyRiskSettings,          // sizing, stops, filters, protection, lifecycle
 *     risk_mode: "fixed_lot" | "dynamic_balance_percent",   // legacy mirror of copy_risk
 *     fixed_lot: number,
 *     dynamic_balance_percent: number,
 *   }
 *
 * The worker cannot import the frontend, so this module is the worker-side reader:
 * it turns that jsonb into a validated, defaulted shape the plan uses.
 *
 * Fail-closed rules:
 *  - A sizing mode this engine does not implement yet (balance/equity ratio,
 *    percent/cash risk, stop distance) becomes 'unsupported', so the plan refuses
 *    to size and no order is sent.
 *  - Safety controls the app writes (emergency stop, pause-new, require-stop, source
 *    volume filters) are surfaced so the plan can refuse to copy while they block.
 *
 * Note: links created by the app carry a legacy default (risk_mode 'fixed_lot',
 * fixed_lot 0.01), so a "fresh" link copies at 0.01 lots rather than doing nothing.
 * That matches what the app itself displays.
 */

/** Why the engine closed a copied trade; written to mirror_copy_trade_mappings.close_reason. */
export const MIRROR_CLOSE_REASON = {
  /** Customer closed the copy, stopped copying, or removed the slave. */
  USER_FORCE_CLOSE: 'user_force_close',
  /** The master trade closed and the copy followed it. */
  SOURCE_CLOSED: 'mirror_source_closed',
  /** The broker position disappeared before the engine closed it (manual/SL/TP). */
  POSITION_GONE: 'position_gone',
} as const

export type MirrorCloseReason = (typeof MIRROR_CLOSE_REASON)[keyof typeof MIRROR_CLOSE_REASON]

export type MirrorCopySizingMode = 'fixed_lot' | 'lot_multiplier' | 'unsupported'
export type MirrorCopyDirectionFilter = 'both' | 'buy' | 'sell'
export type MirrorCopyOrderType = 'market' | 'limit' | 'stop'

export interface MirrorCopySettings {
  /** 'unsupported' means the configured mode cannot be sized by this engine. */
  sizingMode: MirrorCopySizingMode
  /** Multiplier applied to the source volume in 'lot_multiplier' mode. */
  lotMultiplier: number
  /** Absolute lot size used in 'fixed_lot' mode; null when invalid or absent. */
  fixedLot: number | null
  /** Hard ceiling on any single copied position; null means the user set no cap. */
  maxLot: number | null
  /** Per-symbol fixed-lot overrides (uppercased symbol -> lots), applied before the cap. */
  symbolOverrides: Record<string, number>
  /** Which source sides are copied. */
  directionFilter: MirrorCopyDirectionFilter
  /** Whether the source stop loss is mirrored to the destination. */
  copyStopLoss: boolean
  /** Whether the source take profit is mirrored to the destination. */
  copyTakeProfit: boolean
  /** copy_risk.filters.require_stop: copy only positions that carry a stop loss. */
  requireStop: boolean
  /** copy_risk.filters.min_source_volume: ignore smaller source positions. */
  minSourceVolume: number | null
  /** copy_risk.filters.max_source_volume: ignore larger source positions. */
  maxSourceVolume: number | null
  /** copy_risk.protection.emergency_stop: stop copying now. */
  emergencyStop: boolean
  /** copy_risk.lifecycle.pause_new: do not open new copies. */
  pauseNew: boolean
  /** copy_risk.lifecycle.account_locked: the account is locked; do not copy. */
  accountLocked: boolean
  /** copy_risk.filters.order_types: which source order types may be copied. Defaults to ['market']. */
  orderTypes: MirrorCopyOrderType[]
  /** Source-symbol -> destination-symbol rename map, keys and values uppercased. */
  symbolMap: Record<string, string>
}

export const DEFAULT_MIRROR_COPY_SETTINGS: MirrorCopySettings = {
  sizingMode: 'unsupported',
  lotMultiplier: 1,
  fixedLot: null,
  maxLot: null,
  symbolOverrides: {},
  directionFilter: 'both',
  copyStopLoss: true,
  copyTakeProfit: true,
  requireStop: false,
  minSourceVolume: null,
  maxSourceVolume: null,
  emergencyStop: false,
  pauseNew: false,
  accountLocked: false,
  orderTypes: ['market'],
  symbolMap: {},
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function readFirst(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]
  return undefined
}

/** Numbers only: rejects booleans, arrays and objects (Number(true) === 1 would mis-size). */
function readNumber(row: Record<string, unknown>, keys: string[]): number | null {
  const value = readFirst(row, keys)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Accepts real booleans, 0/1 numbers, and common string forms. */
function readBool(row: Record<string, unknown>, keys: string[]): boolean | null {
  const value = readFirst(row, keys)
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true
    if (/^(0|false|no|off)$/i.test(value.trim())) return false
  }
  return null
}

function readString(row: Record<string, unknown>, keys: string[]): string | null {
  const value = readFirst(row, keys)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPositive(row: Record<string, unknown>, keys: string[]): number | null {
  const value = readNumber(row, keys)
  return value != null && value > 0 ? value : null
}

/** Uppercases keys and values, matching AccountConfigPage's symbol_mapping normalisation. */
function parseSymbolMap(raw: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [key, value] of Object.entries(asRecord(raw))) {
    const from = key.trim().toUpperCase()
    const to = typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (from && to) map[from] = to
  }
  return map
}

function parseSymbolOverrides(raw: unknown): Record<string, number> {
  const overrides: Record<string, number> = {}
  if (!Array.isArray(raw)) return overrides
  for (const entry of raw) {
    const row = asRecord(entry)
    const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : ''
    const fixedLot = readPositive(row, ['fixed_lot'])
    if (symbol && fixedLot != null) overrides[symbol] = fixedLot
  }
  return overrides
}

function parseSizing(
  sizing: Record<string, unknown>,
  row: Record<string, unknown>,
): Pick<MirrorCopySettings, 'sizingMode' | 'lotMultiplier' | 'fixedLot' | 'maxLot' | 'symbolOverrides'> {
  const result: Pick<MirrorCopySettings, 'sizingMode' | 'lotMultiplier' | 'fixedLot' | 'maxLot' | 'symbolOverrides'> = {
    sizingMode: 'unsupported', lotMultiplier: 1, fixedLot: null, maxLot: null, symbolOverrides: {},
  }

  const mode = readString(sizing, ['mode'])
  if (mode === 'fixed_lot') {
    const fixedLot = readPositive(sizing, ['fixed_lot'])
    if (fixedLot != null) { result.sizingMode = 'fixed_lot'; result.fixedLot = fixedLot }
    // A fixed_lot mode with a missing/invalid size stays unsupported -> fail closed.
  } else if (mode === 'lot_multiplier') {
    const multiplier = readNumber(sizing, ['lot_multiplier'])
    if (multiplier == null) {
      result.sizingMode = 'lot_multiplier'
    } else if (multiplier > 0) {
      result.sizingMode = 'lot_multiplier'
      result.lotMultiplier = Math.min(multiplier, 100)
    }
    // A zero or negative multiplier stays unsupported -> fail closed.
  } else if (mode != null) {
    // balance_ratio | equity_ratio | percent_risk | cash_risk | stop_distance: not implemented yet.
    result.sizingMode = 'unsupported'
  } else {
    // No copy_risk sizing: fall back to the legacy top-level mirror of the sizing fields.
    const legacyMode = readString(row, ['risk_mode'])
    const legacyFixed = readPositive(row, ['fixed_lot'])
    if (legacyMode === 'fixed_lot' && legacyFixed != null) {
      result.sizingMode = 'fixed_lot'
      result.fixedLot = legacyFixed
    }
    // 'dynamic_balance_percent' or nothing configured -> unsupported.
  }

  result.maxLot = readPositive(sizing, ['max_lot'])
  result.symbolOverrides = parseSymbolOverrides(sizing.symbol_overrides)
  return result
}

/** Parse broker_copy_links.manual_settings into validated settings. Never throws. */
export function parseMirrorCopySettings(raw: unknown): MirrorCopySettings {
  const row = asRecord(raw)
  const risk = asRecord(readFirst(row, ['copy_risk']))
  const sizing = asRecord(readFirst(risk, ['sizing']))
  const stops = asRecord(readFirst(risk, ['stops']))
  const filters = asRecord(readFirst(risk, ['filters']))
  const protection = asRecord(readFirst(risk, ['protection']))
  const lifecycle = asRecord(readFirst(risk, ['lifecycle']))

  const settings: MirrorCopySettings = {
    ...DEFAULT_MIRROR_COPY_SETTINGS,
    ...parseSizing(sizing, row),
  }

  const direction = readString(filters, ['direction'])
  if (direction === 'buy' || direction === 'sell' || direction === 'both') settings.directionFilter = direction

  const copyStopLoss = readBool(stops, ['copy_source_sl'])
  if (copyStopLoss != null) settings.copyStopLoss = copyStopLoss
  const copyTakeProfit = readBool(stops, ['copy_source_tp'])
  if (copyTakeProfit != null) settings.copyTakeProfit = copyTakeProfit

  settings.requireStop = readBool(filters, ['require_stop']) === true
  settings.minSourceVolume = readPositive(filters, ['min_source_volume'])
  settings.maxSourceVolume = readPositive(filters, ['max_source_volume'])
  settings.emergencyStop = readBool(protection, ['emergency_stop']) === true
  settings.pauseNew = readBool(lifecycle, ['pause_new']) === true
  settings.accountLocked = readBool(lifecycle, ['account_locked']) === true

  const orderTypes = readFirst(filters, ['order_types'])
  if (Array.isArray(orderTypes)) {
    settings.orderTypes = orderTypes.filter(
      (value): value is MirrorCopyOrderType => value === 'market' || value === 'limit' || value === 'stop',
    )
  }

  settings.symbolMap = parseSymbolMap(readFirst(row, ['symbol_mapping', 'symbolMap']))
  return settings
}
