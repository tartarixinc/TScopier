"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateChannelCopyLimitPauseForBroker = evaluateChannelCopyLimitPauseForBroker;
const copyLimitEvaluate_1 = require("./copyLimitEvaluate");
const copyLimitTypes_1 = require("./copyLimitTypes");
const channelTradingConfig_1 = require("./channelTradingConfig");
const channelTradingConfig_2 = require("./channelTradingConfig");
function evaluateChannelCopyLimitPauseForBroker(broker, channelId, profileTimezone, stateOverride) {
    if (!channelId)
        return { paused: false };
    const configs = (0, channelTradingConfig_1.healChannelTradingConfigsMap)(broker);
    const channelKey = (0, channelTradingConfig_2.normalizeChannelUuid)(channelId);
    const channelEntry = channelKey ? (0, channelTradingConfig_1.resolveChannelConfigEntry)(configs, channelKey) : undefined;
    const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(broker, channelId);
    const manualFromChannel = channelEntry?.manual_settings;
    const manualFromResolved = resolved.manual_settings ?? {};
    const copyLimits = (0, copyLimitTypes_1.normalizeCopyLimits)(manualFromChannel?.copy_limits ?? manualFromResolved.copy_limits);
    const state = stateOverride ?? (0, copyLimitTypes_1.normalizeCopyLimitState)(channelEntry?.copy_limit_state);
    const timeZone = (0, copyLimitEvaluate_1.resolveCopyLimitTimezone)(copyLimits, profileTimezone);
    const breach = (0, copyLimitEvaluate_1.isChannelCopyLimitPaused)({
        config: copyLimits,
        state,
        timeZone,
    });
    if (!breach)
        return { paused: false };
    return {
        paused: true,
        reason: breach.reason,
        pauseKey: breach.pauseKey,
    };
}
