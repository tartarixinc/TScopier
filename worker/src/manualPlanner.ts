/**
 * Manual-mode order planner (barrel).
 *
 * Implementation lives under `./manualPlanning/`; this file re-exports the
 * stable public surface so callers (e.g. `tradeExecutor`) keep importing `./manualPlanner`.
 */

export type {
  ParsedSignal,
  ManualTpLot,
  ManualSettings,
  ChannelKeywords,
  PlannerContext,
  VirtualPendingLeg,
  PlannerCloseWorseEntries,
  PlannerAnchor,
  PlannerStrictEntry,
  PlannerPartialTp,
  PlannerResult,
  PlanRangeSplitArgs,
  PlanRangeSplitResult,
  ComputeCwOverrideTpArgs,
} from './manualPlanning/types'

export type { PlanSinglePartialTpsArgs, PlanSinglePartialTpsResult } from './manualPlanning/partialTpSchedule'

export { manualUseSignalEntryPriceOn, signalEntryPriceStrictEnabled, clampPendingExpiryHours } from './manualPlanning/manualSettings'

export {
  normalizeManualSettingsForExecution,
  sanitizeTpLots,
  DEFAULT_MANUAL_TP_LOTS,
} from './manualPlanning/normalizeManualSettings'

export {
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  parsedHasExplicitEntryAnchor,
  lastPositiveParsedTpPrice,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
} from './manualPlanning/parsedEntry'

export { reverseSignalGateSatisfied } from './manualPlanning/manualStops'

export { planSinglePartialTps } from './manualPlanning/partialTpSchedule'

export { planRangeSplit } from './manualPlanning/rangeSplit'

export { computeCwOverrideTp } from './manualPlanning/cwOverride'

export { strictSignalEntryQuoteAllowsImmediate } from './manualPlanning/executionShape'

export { planManualOrders } from './manualPlanning/planManualOrders'
