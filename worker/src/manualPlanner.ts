/**
 * Manual-mode order planner (barrel).
 *
 * Implementation lives under `./manualPlanning/`; this file re-exports the
 * stable public surface so callers (e.g. `tradeExecutor`) keep importing `./manualPlanner`.
 */

export type {
  ParsedSignal,
  ManualSettings,
  ChannelKeywords,
  PlannerContext,
  VirtualPendingLeg,
  PlannerPartialTp,
  PlannerResult,
} from './manualPlanning/types'

export {
  signalEntryPriceStrictEnabled,
  signalEntryRangeStrictEnabled,
  clampPendingExpiryHours,
} from './manualPlanning/manualSettings'

export {
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  parsedHasExplicitEntryAnchor,
  lastPositiveParsedTpPrice,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED,
  SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED,
} from './manualPlanning/parsedEntry'

export {
  buildRangeEntryWait,
  signalRangeEntryQuoteAllowsImmediate,
} from './manualPlanning/signalEntryRange'

export { reverseSignalGateSatisfied } from './manualPlanning/manualStops'

export { planSinglePartialTps } from './manualPlanning/partialTpSchedule'

export { planRangeSplit } from './manualPlanning/rangeSplit'

export { computeCwOverrideTp } from './manualPlanning/cwOverride'

export { strictSignalEntryQuoteAllowsImmediate } from './manualPlanning/executionShape'

export { planManualOrders } from './manualPlanning/planManualOrders'
