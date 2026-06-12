"use strict";
/**
 * Same-telegram-message revision (duplicate message_id + changed text).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MESSAGE_REVISION_DISPATCH_SOURCE = void 0;
exports.messageTextChanged = messageTextChanged;
exports.loadSignalByTelegramMessage = loadSignalByTelegramMessage;
exports.buildRevisionDispatchRow = buildRevisionDispatchRow;
exports.updateSignalAfterRevision = updateSignalAfterRevision;
exports.normalizedTradeAction = normalizedTradeAction;
exports.revisionDirectionFlippedFromActions = revisionDirectionFlippedFromActions;
exports.storedMessageDiffersFromTelegram = storedMessageDiffersFromTelegram;
exports.entryDispatchLooksSettleable = entryDispatchLooksSettleable;
exports.MESSAGE_REVISION_DISPATCH_SOURCE = 'message_revision';
function messageTextChanged(stored, fetched) {
    return stored.trim() !== fetched.trim();
}
async function loadSignalByTelegramMessage(supabase, args) {
    const { data, error } = await supabase
        .from('signals')
        .select('id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelRowId)
        .eq('telegram_message_id', args.telegramMessageId)
        .maybeSingle();
    if (error || !data)
        return null;
    return data;
}
function buildRevisionDispatchRow(existing, parseResult, pipelineTs) {
    return {
        id: existing.id,
        user_id: existing.user_id,
        channel_id: existing.channel_id,
        parsed_data: parseResult.parsed,
        status: 'parsed',
        parent_signal_id: existing.parent_signal_id,
        is_modification: existing.is_modification,
        telegram_message_id: existing.telegram_message_id,
        reply_to_message_id: existing.reply_to_message_id,
        created_at: existing.created_at,
        pipeline_ts: pipelineTs,
    };
}
async function updateSignalAfterRevision(supabase, args) {
    const patch = {
        raw_message: args.rawMessage,
        parsed_data: args.parseResult.parsed,
        status: 'parsed',
        skip_reason: null,
        telegram_reconciled_at: new Date().toISOString(),
    };
    if (args.telegramEditDateSeen != null && args.telegramEditDateSeen > 0) {
        patch.telegram_edit_date_seen = Math.floor(args.telegramEditDateSeen);
    }
    const { error } = await supabase
        .from('signals')
        .update(patch)
        .eq('id', args.signalId);
    return !error;
}
function normalizedTradeAction(action) {
    const a = String(action ?? '').toLowerCase();
    if (a === 'buy' || a === 'sell')
        return a;
    return null;
}
function revisionDirectionFlippedFromActions(priorAction, nextAction) {
    const oldA = normalizedTradeAction(priorAction);
    const newA = normalizedTradeAction(nextAction);
    if (!oldA || !newA)
        return false;
    return oldA !== newA;
}
function storedMessageDiffersFromTelegram(stored, fetched) {
    return messageTextChanged(stored, fetched);
}
/** Bare market teaser (e.g. "Gold buy now") that channels often edit seconds later with SL/TP. */
function entryDispatchLooksSettleable(parsed) {
    const action = String(parsed?.action ?? '').toLowerCase();
    if (action !== 'buy' && action !== 'sell')
        return false;
    if (parsed?.sl != null && Number(parsed.sl) > 0)
        return false;
    const tps = Array.isArray(parsed?.tp) ? parsed.tp : [];
    if (tps.some(t => Number(t) > 0))
        return false;
    if (parsed?.entry_price != null && Number(parsed.entry_price) > 0)
        return false;
    if (parsed?.entry_zone_low != null && Number(parsed.entry_zone_low) > 0)
        return false;
    if (parsed?.entry_zone_high != null && Number(parsed.entry_zone_high) > 0)
        return false;
    return true;
}
