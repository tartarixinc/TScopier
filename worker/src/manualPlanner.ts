/**
 * Manual-mode order planner (barrel).
 *
 * Implementation lives under `./manualPlanning/`; this file re-exports the
 * stable public surface so callers (e.g. `tradeExecutor`) keep importing `./manualPlanner`.
 */

export type {
  ParsedSignal,
  EntryOrderType,
  ManualSettings,
  LayeringMode,
  LayeringPlanSnapshot,
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
  SKIP_REASON_ENTRY_NOT_OPENED,
} from './manualPlanning/parsedEntry'

export {
  buildRangeEntryWait,
  signalRangeEntryQuoteAllowsImmediate,
} from './manualPlanning/signalEntryRange'

export { reverseSignalGateSatisfied } from './manualPlanning/manualStops'

export { planSinglePartialTps } from './manualPlanning/partialTpSchedule'

export { planRangeSplit } from './manualPlanning/rangeSplit'

export {
  DEFAULT_LAYERING_MODE,
  DEFAULT_STATIC_LAYER_COUNT,
  DEFAULT_DYNAMIC_STEP_PIPS,
  DEFAULT_DYNAMIC_MAX_LAYERS,
  MIN_LAYER_COUNT,
  MAX_LAYER_COUNT,
  resolveLayeringMode,
  isLegacyLayeringMode,
  isStaticLayeringMode,
  isDynamicLayeringMode,
  layeringModesExecutionEnabled,
  normalizeLayeringModeSettings,
  assertLayeringModeExecutionSupported,
  parseLayeringPlanSnapshot,
  serializeLayeringPlanSnapshot,
  changeLayeringPlanMode,
} from './manualPlanning/layeringModes'

export { computeCwOverrideTp } from './manualPlanning/cwOverride'

export { strictSignalEntryQuoteAllowsImmediate } from './manualPlanning/executionShape'

export { planManualOrders } from './manualPlanning/planManualOrders'
