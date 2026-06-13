"use strict";
/**
 * Same-telegram-message revision (duplicate message_id + changed text).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MESSAGE_REVISION_DISPATCH_SOURCE = void 0;
exports.messageTextChanged = messageTextChanged;
exports.isIncomingRevisionStale = isIncomingRevisionStale;
exports.loadSignalByTelegramMessage = loadSignalByTelegramMessage;
exports.loadSignalById = loadSignalById;
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
/** True when incoming Telegram edit_date is strictly older than what we already stored. */
function isIncomingRevisionStale(storedEditDateSeen, incomingEditDateSeen) {
    const stored = storedEditDateSeen != null && Number(storedEditDateSeen) > 0
        ? Math.floor(Number(storedEditDateSeen))
        : null;
    const incoming = incomingEditDateSeen != null && Number(incomingEditDateSeen) > 0
        ? Math.floor(Number(incomingEditDateSeen))
        : null;
    if (stored == null || incoming == null)
        return false;
    return incoming < stored;
}
async function loadSignalByTelegramMessage(supabase, args) {
    const { data, error } = await supabase
        .from('signals')
        .select('id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelRowId)
        .eq('telegram_message_id', args.telegramMessageId)
        .maybeSingle();
    if (error || !data)
        return null;
    const row = data;
    row.telegram_edit_date_seen =
        row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
            ? Number(row.telegram_edit_date_seen)
            : null;
    return row;
}
async function loadSignalById(supabase, signalId) {
    const { data, error } = await supabase
        .from('signals')
        .select('id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen')
        .eq('id', signalId)
        .maybeSingle();
    if (error || !data)
        return null;
    const row = data;
    row.telegram_edit_date_seen =
        row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
            ? Number(row.telegram_edit_date_seen)
            : null;
    return row;
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
    let query = supabase
        .from('signals')
        .update(patch)
        .eq('id', args.signalId);
    if (args.telegramEditDateSeen != null && args.telegramEditDateSeen > 0) {
        const newEdit = Math.floor(args.telegramEditDateSeen);
        query = query.or(`telegram_edit_date_seen.is.null,telegram_edit_date_seen.lte.${newEdit}`);
    }
    const { data, error } = await query.select('id').maybeSingle();
    return !error && data != null;
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
