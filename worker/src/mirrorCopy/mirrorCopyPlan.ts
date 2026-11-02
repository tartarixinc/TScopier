/**
 * Mirror copy decisions.
 *
 * Pure functions: given the user's settings and a source position, decide what the
 * destination should look like. No broker, no database, no clock — so every rule is
 * unit-testable and the execution kernel stays free of policy.
 *
 * The returned volume is "requested" and is already capped by the user's max_lot, but
 * is not yet clamped to the destination symbol's min/max/step; the execution layer
 * applies constrainedCopyVolume/symbolLimits for that.
 *
 * planMirrorCopy returns null (do not copy) for every blocking condition: an
 * unsupported/absent sizing mode, the direction filter, an emergency stop, pause-new,
 * require-stop with no stop, and source-volume filters. A null plan is a deliberate
 * "skip", never an error.
 */
import type { NormalizedSourcePosition } from '../copyShared/copyHelpers'
import type { MirrorCopySettings } from './mirrorCopyTypes'

export interface MirrorCopyPlan {
  symbol: string
  side: 'buy' | 'sell'
  requestedVolume: number
  stopLoss: number | null
  takeProfit: number | null
}

/** Destination symbol for a source symbol, honouring the optional rename map. */
export function mirrorCopySymbol(settings: MirrorCopySettings, sourceSymbol: string): string {
  const symbol = sourceSymbol.trim()
  return settings.symbolMap[symbol.toUpperCase()] ?? symbol
}

/** Whether the direction filter allows copying the given source side. */
export function directionAllows(settings: MirrorCopySettings, side: 'buy' | 'sell'): boolean {
  return settings.directionFilter === 'both' || settings.directionFilter === side
}

/**
 * Requested destination volume before symbol-limit clamping. Null when the sizing
 * mode is unsupported, the size cannot be derived, or the source volume is unusable.
 * A per-symbol override and the user's max_lot are applied here, so they hold
 * regardless of caller.
 */
export function mirrorCopyVolume(settings: MirrorCopySettings, sourceVolume: number, symbol?: string): number | null {
  if (!Number.isFinite(sourceVolume) || sourceVolume <= 0) return null
  if (settings.sizingMode === 'unsupported') return null

  const override = symbol ? settings.symbolOverrides[symbol.trim().toUpperCase()] : undefined
  let requested: number
  if (override != null) {
    requested = override
  } else if (settings.sizingMode === 'fixed_lot') {
    if (settings.fixedLot == null) return null
    requested = settings.fixedLot
  } else {
    requested = sourceVolume * settings.lotMultiplier
  }

  if (!Number.isFinite(requested) || requested <= 0) return null
  if (settings.maxLot != null) requested = Math.min(requested, settings.maxLot)
  return requested
}

/** Mirror the source stops onto the destination, honouring the copy toggles. */
export function mirrorCopyStops(
  settings: MirrorCopySettings,
  position: Pick<NormalizedSourcePosition, 'stopLoss' | 'takeProfit'>,
): { stopLoss: number | null; takeProfit: number | null } {
  return {
    stopLoss: settings.copyStopLoss ? position.stopLoss : null,
    takeProfit: settings.copyTakeProfit ? position.takeProfit : null,
  }
}

/** Whether the source position passes the user's filters. */
export function sourcePositionAllowed(settings: MirrorCopySettings, position: NormalizedSourcePosition): boolean {
  if (settings.emergencyStop || settings.pauseNew || settings.accountLocked) return false
  if (!directionAllows(settings, position.side)) return false
  // The source positions this engine handles are always market positions.
  if (!settings.orderTypes.includes('market')) return false
  if (settings.requireStop && !(position.stopLoss != null && position.stopLoss > 0)) return false
  if (settings.minSourceVolume != null && position.volume < settings.minSourceVolume) return false
  if (settings.maxSourceVolume != null && position.volume > settings.maxSourceVolume) return false
  return true
}

/** Combine every decision into a plan, or null when the position must not be copied. */
export function planMirrorCopy(settings: MirrorCopySettings, position: NormalizedSourcePosition): MirrorCopyPlan | null {
  if (!sourcePositionAllowed(settings, position)) return null
  // Sizing overrides are keyed on the destination symbol, matching the app's evaluator.
  const symbol = mirrorCopySymbol(settings, position.symbol)
  const requestedVolume = mirrorCopyVolume(settings, position.volume, symbol)
  if (requestedVolume == null) return null
  const stops = mirrorCopyStops(settings, position)
  return {
    symbol,
    side: position.side,
    requestedVolume,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit,
  }
}
