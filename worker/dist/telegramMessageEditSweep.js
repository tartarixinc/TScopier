"use strict";
/**
 * Poll-based detection for silent Telegram message edits (no EditedMessage event).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE = exports.EDIT_POLL_HOOK_MAX_SIGNALS = exports.EDIT_POLL_HOOK_WINDOW_MS = exports.EDIT_SWEEP_MAX_SIGNALS = exports.EDIT_SWEEP_INTERVAL_MS = exports.EDIT_SWEEP_WINDOW_MS = void 0;
exports.messageTextChanged = messageTextChanged;
exports.telegramEditDateSec = telegramEditDateSec;
exports.telegramMessageText = telegramMessageText;
exports.shouldCheckMessageForEdit = shouldCheckMessageForEdit;
exports.findEditedSignals = findEditedSignals;
exports.groupSignalsByChannel = groupSignalsByChannel;
exports.chunkTelegramMessageIds = chunkTelegramMessageIds;
exports.loadSignalsForEditSweep = loadSignalsForEditSweep;
exports.snapshotsFromTelegramMessages = snapshotsFromTelegramMessages;
exports.EDIT_SWEEP_WINDOW_MS = Math.max(60000, Math.min(24 * 60 * 60000, Number(process.env.TELEGRAM_EDIT_SWEEP_WINDOW_MS ?? 4 * 60 * 60000)));
exports.EDIT_SWEEP_INTERVAL_MS = Math.max(10000, Math.min(120000, Number(process.env.TELEGRAM_EDIT_SWEEP_MS ?? 30000)));
exports.EDIT_SWEEP_MAX_SIGNALS = Math.max(10, Math.min(200, Number(process.env.TELEGRAM_EDIT_SWEEP_MAX_SIGNALS ?? 80)));
exports.EDIT_POLL_HOOK_WINDOW_MS = Math.max(30000, Math.min(6 * 60 * 60000, Number(process.env.TELEGRAM_EDIT_POLL_HOOK_WINDOW_MS ?? 2 * 60 * 60000)));
exports.EDIT_POLL_HOOK_MAX_SIGNALS = Math.max(5, Math.min(50, Number(process.env.TELEGRAM_EDIT_POLL_HOOK_MAX_SIGNALS ?? 20)));
exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100;
function messageTextChanged(stored, fetched) {
    return stored.trim() !== fetched.trim();
}
/** Read gramjs/Telethon edit timestamp (unix seconds) when present. */
function telegramEditDateSec(message) {
    if (message == null || typeof message !== 'object')
        return null;
    const m = message;
    const raw = m.editDate ?? m.edit_date;
    if (raw == null)
        return null;
    if (raw instanceof Date) {
        const sec = Math.floor(raw.getTime() / 1000);
        return Number.isFinite(sec) && sec > 0 ? sec : null;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function telegramMessageText(message) {
    if (message == null || typeof message !== 'object')
        return '';
    const m = message;
    return String(m.text ?? m.message ?? '').trim();
}
function shouldCheckMessageForEdit(stored, fetched) {
    const storedEdit = stored.telegram_message_edit_date;
    const fetchedEdit = fetched.editDateSec;
    if (storedEdit != null
        && storedEdit > 0
        && fetchedEdit != null
        && fetchedEdit > 0
        && fetchedEdit <= storedEdit
        && !messageTextChanged(stored.raw_message, fetched.text)) {
        return false;
    }
    return messageTextChanged(stored.raw_message, fetched.text);
}
function findEditedSignals(signals, telegramByMessageId) {
    const out = [];
    for (const signal of signals) {
        const mid = signal.telegram_message_id?.trim();
        if (!mid)
            continue;
        const snap = telegramByMessageId.get(mid);
        if (!snap)
            continue;
        if (!shouldCheckMessageForEdit(signal, snap))
            continue;
        out.push({
            signal,
            rawMessage: snap.text,
            editDateSec: snap.editDateSec,
        });
    }
    return out;
}
function groupSignalsByChannel(signals) {
    const grouped = new Map();
    for (const row of signals) {
        const channelId = row.channel_id?.trim();
        if (!channelId)
            continue;
        const list = grouped.get(channelId) ?? [];
        list.push(row);
        grouped.set(channelId, list);
    }
    return grouped;
}
function chunkTelegramMessageIds(ids) {
    const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
    const chunks = [];
    for (let i = 0; i < unique.length; i += exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE) {
        chunks.push(unique.slice(i, i + exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE));
    }
    return chunks;
}
const EDIT_SWEEP_STATUSES = ['parsed', 'executed'];
async function loadSignalsForEditSweep(supabase, args) {
    const windowMs = args.windowMs ?? exports.EDIT_SWEEP_WINDOW_MS;
    const maxSignals = args.maxSignals ?? exports.EDIT_SWEEP_MAX_SIGNALS;
    const since = new Date(Date.now() - windowMs).toISOString();
    let openSignalIds = null;
    if (args.openTradesOnly !== false) {
        const { data: openTrades } = await supabase
            .from('trades')
            .select('signal_id')
            .eq('user_id', args.userId)
            .eq('status', 'open')
            .gte('opened_at', since)
            .limit(500);
        openSignalIds = new Set((openTrades ?? [])
            .map(r => r.signal_id)
            .filter((id) => typeof id === 'string' && id.length > 0));
    }
    const selectWithEditDate = 'id,channel_id,telegram_message_id,raw_message,telegram_message_edit_date,created_at';
    const selectWithoutEditDate = 'id,channel_id,telegram_message_id,raw_message,created_at';
    const runQuery = async (select) => {
        let query = supabase
            .from('signals')
            .select(select)
            .eq('user_id', args.userId)
            .not('telegram_message_id', 'is', null)
            .in('status', [...EDIT_SWEEP_STATUSES])
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(Math.min(maxSignals * 3, 240));
        if (args.channelRowId) {
            query = query.eq('channel_id', args.channelRowId);
        }
        return query;
    };
    let { data, error } = await runQuery(selectWithEditDate);
    if (error && /telegram_message_edit_date/i.test(String(error.message ?? ''))) {
        ;
        ({ data, error } = await runQuery(selectWithoutEditDate));
    }
    if (error || !data?.length)
        return [];
    const rows = data
        .filter(r => r.channel_id && r.telegram_message_id);
    const prioritized = openSignalIds
        ? [
            ...rows.filter(r => openSignalIds.has(r.id)),
            ...rows.filter(r => !openSignalIds.has(r.id)),
        ]
        : rows;
    const seen = new Set();
    const out = [];
    for (const row of prioritized) {
        if (seen.has(row.id))
            continue;
        seen.add(row.id);
        out.push({
            id: row.id,
            channel_id: row.channel_id,
            telegram_message_id: String(row.telegram_message_id),
            raw_message: row.raw_message ?? '',
            telegram_message_edit_date: row.telegram_message_edit_date != null && Number.isFinite(Number(row.telegram_message_edit_date))
                ? Number(row.telegram_message_edit_date)
                : null,
        });
        if (out.length >= maxSignals)
            break;
    }
    return out;
}
function snapshotsFromTelegramMessages(messages) {
    const out = new Map();
    for (const message of messages) {
        if (message == null || typeof message !== 'object')
            continue;
        const idRaw = message.id;
        if (idRaw == null)
            continue;
        const id = String(idRaw).trim();
        if (!id)
            continue;
        out.set(id, {
            text: telegramMessageText(message),
            editDateSec: telegramEditDateSec(message),
        });
    }
    return out;
}
