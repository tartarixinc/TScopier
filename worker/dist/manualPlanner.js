"use strict";
/**
 * Manual-mode order planner (barrel).
 *
 * Implementation lives under `./manualPlanning/`; this file re-exports the
 * stable public surface so callers (e.g. `tradeExecutor`) keep importing `./manualPlanner`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.planManualOrders = exports.strictSignalEntryQuoteAllowsImmediate = exports.computeCwOverrideTp = exports.planRangeSplit = exports.planSinglePartialTps = exports.reverseSignalGateSatisfied = exports.SKIP_REASON_SIGNAL_ENTRY_REQUIRED = exports.lastPositiveParsedTpPrice = exports.parsedHasExplicitEntryAnchor = exports.resolvedParsedEntryZone = exports.resolvedParsedEntryPrice = exports.clampPendingExpiryHours = exports.signalEntryPriceStrictEnabled = exports.manualUseSignalEntryPriceOn = void 0;
var manualSettings_1 = require("./manualPlanning/manualSettings");
Object.defineProperty(exports, "manualUseSignalEntryPriceOn", { enumerable: true, get: function () { return manualSettings_1.manualUseSignalEntryPriceOn; } });
Object.defineProperty(exports, "signalEntryPriceStrictEnabled", { enumerable: true, get: function () { return manualSettings_1.signalEntryPriceStrictEnabled; } });
Object.defineProperty(exports, "clampPendingExpiryHours", { enumerable: true, get: function () { return manualSettings_1.clampPendingExpiryHours; } });
var parsedEntry_1 = require("./manualPlanning/parsedEntry");
Object.defineProperty(exports, "resolvedParsedEntryPrice", { enumerable: true, get: function () { return parsedEntry_1.resolvedParsedEntryPrice; } });
Object.defineProperty(exports, "resolvedParsedEntryZone", { enumerable: true, get: function () { return parsedEntry_1.resolvedParsedEntryZone; } });
Object.defineProperty(exports, "parsedHasExplicitEntryAnchor", { enumerable: true, get: function () { return parsedEntry_1.parsedHasExplicitEntryAnchor; } });
Object.defineProperty(exports, "lastPositiveParsedTpPrice", { enumerable: true, get: function () { return parsedEntry_1.lastPositiveParsedTpPrice; } });
Object.defineProperty(exports, "SKIP_REASON_SIGNAL_ENTRY_REQUIRED", { enumerable: true, get: function () { return parsedEntry_1.SKIP_REASON_SIGNAL_ENTRY_REQUIRED; } });
var manualStops_1 = require("./manualPlanning/manualStops");
Object.defineProperty(exports, "reverseSignalGateSatisfied", { enumerable: true, get: function () { return manualStops_1.reverseSignalGateSatisfied; } });
var partialTpSchedule_1 = require("./manualPlanning/partialTpSchedule");
Object.defineProperty(exports, "planSinglePartialTps", { enumerable: true, get: function () { return partialTpSchedule_1.planSinglePartialTps; } });
var rangeSplit_1 = require("./manualPlanning/rangeSplit");
Object.defineProperty(exports, "planRangeSplit", { enumerable: true, get: function () { return rangeSplit_1.planRangeSplit; } });
var cwOverride_1 = require("./manualPlanning/cwOverride");
Object.defineProperty(exports, "computeCwOverrideTp", { enumerable: true, get: function () { return cwOverride_1.computeCwOverrideTp; } });
var executionShape_1 = require("./manualPlanning/executionShape");
Object.defineProperty(exports, "strictSignalEntryQuoteAllowsImmediate", { enumerable: true, get: function () { return executionShape_1.strictSignalEntryQuoteAllowsImmediate; } });
var planManualOrders_1 = require("./manualPlanning/planManualOrders");
Object.defineProperty(exports, "planManualOrders", { enumerable: true, get: function () { return planManualOrders_1.planManualOrders; } });
