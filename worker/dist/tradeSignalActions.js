"use strict";
/**
 * Parsed-signal action classification for trade routing, queues, and split workers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsedAction = parsedAction;
exports.isManagementAction = isManagementAction;
exports.isEntryAction = isEntryAction;
exports.tradeExecutorModeForRole = tradeExecutorModeForRole;
exports.signalMatchesExecutorMode = signalMatchesExecutorMode;
exports.isTimeSensitiveManagementAction = isTimeSensitiveManagementAction;
exports.dispatchPriorityForAction = dispatchPriorityForAction;
function parsedAction(parsed) {
    return String(parsed?.action ?? '').toLowerCase().trim();
}
function isManagementAction(action) {
    const a = action.toLowerCase();
    return a === 'close'
        || a === 'close_worse_entries'
        || a === 'breakeven'
        || a === 'partial_profit'
        || a === 'partial_breakeven'
        || a === 'modify';
}
function isEntryAction(action) {
    const a = action.toLowerCase();
    return a === 'buy' || a === 'sell';
}
function tradeExecutorModeForRole(role) {
    if (role === 'trade_entry')
        return 'entry';
    if (role === 'trade_mgmt')
        return 'mgmt';
    return 'all';
}
/** Whether this worker role should execute the parsed action. */
function signalMatchesExecutorMode(parsed, mode) {
    if (mode === 'all')
        return true;
    const action = parsedAction(parsed);
    if (!action || action === 'ignore')
        return false;
    if (mode === 'entry')
        return isEntryAction(action);
    if (mode === 'mgmt')
        return isManagementAction(action);
    return true;
}
function isTimeSensitiveManagementAction(action) {
    const a = action.toLowerCase();
    return a === 'close_worse_entries' || a === 'close' || a === 'modify';
}
function dispatchPriorityForAction(action) {
    if (isEntryAction(action))
        return 'high';
    if (isTimeSensitiveManagementAction(action))
        return 'high';
    return 'normal';
}
