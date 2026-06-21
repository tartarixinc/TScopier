"use strict";
/**
 * Telegram message edit → re-parse existing signal → SL/TP refresh dispatch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MESSAGE_EDIT_DISPATCH_SOURCE = void 0;
exports.loadSignalByTelegramMessage = loadSignalByTelegramMessage;
exports.buildMessageEditDispatchRow = buildMessageEditDispatchRow;
exports.updateSignalAfterTelegramEdit = updateSignalAfterTelegramEdit;
exports.normalizedTradeAction = normalizedTradeAction;
exports.messageEditDirectionFlipped = messageEditDirectionFlipped;
exports.messageEditDirectionFlippedFromActions = messageEditDirectionFlippedFromActions;
exports.storedMessageDiffersFromTelegram = storedMessageDiffersFromTelegram;
exports.messageEditParseEligible = messageEditParseEligible;
const multiTradeMerge_1 = require("./multiTradeMerge");
const telegramMessageEditSweep_1 = require("./telegramMessageEditSweep");
exports.MESSAGE_EDIT_DISPATCH_SOURCE = 'message_edit';
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
function buildMessageEditDispatchRow(existing, parseResult, rawMessage, pipelineTs) {
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
async function updateSignalAfterTelegramEdit(supabase, args) {
    const editedAt = new Date().toISOString();
    const patch = {
        raw_message: args.rawMessage,
        parsed_data: args.parseResult.parsed,
        status: 'parsed',
        skip_reason: null,
        telegram_message_edited_at: editedAt,
    };
    if (args.telegramMessageEditDate != null && args.telegramMessageEditDate > 0) {
        patch.telegram_message_edit_date = Math.floor(args.telegramMessageEditDate);
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
function messageEditDirectionFlipped(existing, parseResult) {
    return messageEditDirectionFlippedFromActions(existing.parsed_data?.action, parseResult.parsed?.action);
}
function messageEditDirectionFlippedFromActions(priorAction, nextAction) {
    const oldA = normalizedTradeAction(priorAction);
    const newA = normalizedTradeAction(nextAction);
    if (!oldA || !newA)
        return false;
    return oldA !== newA;
}
function storedMessageDiffersFromTelegram(stored, fetched) {
    return (0, telegramMessageEditSweep_1.messageTextChanged)(stored, fetched);
}
function messageEditParseEligible(parseResult) {
    if (parseResult.status !== 'parsed')
        return false;
    return (0, multiTradeMerge_1.parsedHasSlOrTp)(parseResult.parsed);
}
