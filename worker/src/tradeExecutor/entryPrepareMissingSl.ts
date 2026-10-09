import {
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  type ManualSettings,
  type ParsedSignal,
} from '../manualPlanner'
import { resolvePredefinedSlPips } from '../manualPlanning/manualStops'
import {
  ENTRY_TP_WITHOUT_SL_REASON,
  entryHasTpWithoutSl,
  messageHasExplicitStopLabel,
  parsedHasSlOrTp,
} from '../signalEntryNowRequirement'
import {
  SIGNAL_MISSING_REQUIRED_SL,
  isStopLossWithheldByProvider,
} from '../brokerTradeError'

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parsedEntryAnchorForFallback(parsed: ParsedSignal): number | null {
  const entry = resolvedParsedEntryPrice(parsed)
  if (entry != null) return entry
  const zone = resolvedParsedEntryZone(parsed)
  return zone != null ? (zone.lo + zone.hi) / 2 : null
}

/** Narrow exception: only an explicit provider lifecycle New Order is independent. */
export function isExplicitProviderNewOrder(parsed: ParsedSignal): boolean {
  return parsed.provider_order_type === 'new'
}

export function shouldEnforceSingleOpenSymbolSlot(
  parsed: ParsedSignal,
  manual: ManualSettings,
): boolean {
  return manual.add_new_trades_to_existing === false && !isExplicitProviderNewOrder(parsed)
}

/**
 * Account can supply a stop loss without a numeric signal SL:
 * Override signal SL (from fill/quote — no signal entry required), or RR from a TP.
 */
export function configuredFallbackSlPossible(parsed: ParsedSignal, manual: ManualSettings): boolean {
  if (resolvePredefinedSlPips(manual) != null) return true
  const anchor = parsedEntryAnchorForFallback(parsed)
  const firstTp = (parsed.tp ?? []).map(positiveNumber).find((n): n is number => n != null)
  return manual.rr_for_sl_enabled === true
    && positiveNumber(manual.rr_for_sl) != null
    && firstTp != null
    && anchor != null
}

/**
 * A revision is exempt from entry SL validation only after this signal/broker
 * has actually materialized an entry or durable pending artifact.
 */
export function shouldRunMissingRequiredSlPolicy(
  isManual: boolean,
  revisionAlreadyMaterialized: boolean,
): boolean {
  return isManual && !revisionAlreadyMaterialized
}
/**
 * True when the message *did* state a stop loss but the parser could not read its
 * price. Callers use this so the user is told "we could not read the stop loss"
 * instead of "the signal had no stop loss".
 */
export function stopStatedButUnreadable(parsed: ParsedSignal): boolean {
  if (positiveNumber(parsed.sl) != null) return false
  const rawInstruction = parsed.raw_instruction ?? ''
  if (isStopLossWithheldByProvider(rawInstruction)) return false
  return messageHasExplicitStopLabel(rawInstruction)
}
/**
 * Returns a skip when the entry must not open due to a missing stop loss.
 * Override signal SL always wins: Premium / missing / wrong-side signal SL still execute.
 * - TP without usable SL → `entry_tp_without_sl` (unless predefined/RR fallback applies)
 * - `add_new_trades_to_existing === false` with no explicit stops → `SIGNAL_MISSING_REQUIRED_SL`
 */
export function missingRequiredSlFailure(parsed: ParsedSignal, manual: ManualSettings): {
  withheldByProvider: boolean
  reason: string
} | null {
  if (positiveNumber(parsed.sl) != null) return null
  if (configuredFallbackSlPossible(parsed, manual)) return null

  const withheldByProvider = isStopLossWithheldByProvider(parsed.raw_instruction)

  if (entryHasTpWithoutSl(parsed)) {
    return { withheldByProvider, reason: ENTRY_TP_WITHOUT_SL_REASON }
  }

  if (manual.add_new_trades_to_existing === false && !parsedHasSlOrTp(parsed)) {
    return { withheldByProvider, reason: SIGNAL_MISSING_REQUIRED_SL }
  }
  return null
}
