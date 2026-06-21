"use strict";
/**
 * Poll-based reconciliation: compare stored signals with live Telegram message text.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE = exports.RECONCILE_POLL_HOOK_MAX_SIGNALS = exports.RECONCILE_POLL_HOOK_WINDOW_MS = exports.RECONCILE_SWEEP_MAX_SIGNALS = exports.RECONCILE_SWEEP_INTERVAL_MS = exports.RECONCILE_SWEEP_WINDOW_MS = void 0;
exports.signalLooksLikeTeaserBasket = signalLooksLikeTeaserBasket;
exports.telegramEditDateSec = telegramEditDateSec;
exports.telegramMessageText = telegramMessageText;
exports.shouldReconcileSignal = shouldReconcileSignal;
exports.findSignalsNeedingReconcile = findSignalsNeedingReconcile;
exports.groupSignalsByChannel = groupSignalsByChannel;
exports.chunkTelegramMessageIds = chunkTelegramMessageIds;
exports.snapshotsFromTelegramMessages = snapshotsFromTelegramMessages;
exports.loadSignalsForReconcile = loadSignalsForReconcile;
exports.markSignalsReconciled = markSignalsReconciled;
const signalRevision_1 = require("./signalRevision");
const normalizeTelegramMessageText_1 = require("./normalizeTelegramMessageText");
exports.RECONCILE_SWEEP_WINDOW_MS = Math.max(60000, Math.min(24 * 60 * 60000, Number(process.env.SIGNAL_RECONCILE_WINDOW_MS ?? 6 * 60 * 60000)));
exports.RECONCILE_SWEEP_INTERVAL_MS = Math.max(15000, Math.min(300000, Number(process.env.SIGNAL_RECONCILE_SWEEP_MS ?? 60000)));
exports.RECONCILE_SWEEP_MAX_SIGNALS = Math.max(10, Math.min(300, Number(process.env.SIGNAL_RECONCILE_MAX_SIGNALS ?? 100)));
exports.RECONCILE_POLL_HOOK_WINDOW_MS = Math.max(30000, Math.min(6 * 60 * 60000, Number(process.env.SIGNAL_RECONCILE_POLL_HOOK_WINDOW_MS ?? 2 * 60 * 60000)));
exports.RECONCILE_POLL_HOOK_MAX_SIGNALS = Math.max(5, Math.min(80, Number(process.env.SIGNAL_RECONCILE_POLL_HOOK_MAX_SIGNALS ?? 30)));
exports.TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100;
const RECONCILE_STATUSES = ['parsed', 'executed'];
/** Executed teaser entries (open legs, no SL in parsed_data) need reconcile most. */
function signalLooksLikeTeaserBasket(parsed) {
    if (!parsed)
        return false;
    const action = String(parsed.action ?? '').toLowerCase();
    if (action !== 'buy' && action !== 'sell')
        return false;
    const sl = parsed.sl;
    if (sl != null && Number(sl) > 0)
        return false;
    const tps = Array.isArray(parsed.tp) ? parsed.tp : [];
    if (tps.some(t => Number(t) > 0))
        return false;
    return true;
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
    return (0, normalizeTelegramMessageText_1.normalizeTelegramMessageText)(String(m.text ?? m.message ?? ''));
}
function shouldReconcileSignal(stored, fetched) {
    const storedEdit = stored.telegram_edit_date_seen;
    const fetchedEdit = fetched.editDateSec;
    if ((0, signalRevision_1.isIncomingRevisionStale)(storedEdit, fetchedEdit)) {
        return false;
    }
    if (storedEdit != null
        && storedEdit > 0
        && fetchedEdit != null
        && fetchedEdit > 0
        && fetchedEdit <= storedEdit
        && !(0, signalRevision_1.messageTextChanged)(stored.raw_message, fetched.text)) {
        return false;
    }
    return (0, signalRevision_1.messageTextChanged)(stored.raw_message, fetched.text);
}
function findSignalsNeedingReconcile(signals, telegramByMessageId) {
    const out = [];
    for (const signal of signals) {
        const mid = signal.telegram_message_id?.trim();
        if (!mid)
            continue;
        const snap = telegramByMessageId.get(mid);
        if (!snap)
            continue;
        if (!shouldReconcileSignal(signal, snap))
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
async function loadSignalsForReconcile(supabase, args) {
    const windowMs = args.windowMs ?? exports.RECONCILE_SWEEP_WINDOW_MS;
    const maxSignals = args.maxSignals ?? exports.RECONCILE_SWEEP_MAX_SIGNALS;
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
    let query = supabase
        .from('signals')
        .select('id,channel_id,telegram_message_id,raw_message,telegram_edit_date_seen,created_at,parsed_data')
        .eq('user_id', args.userId)
        .not('telegram_message_id', 'is', null)
        .in('status', [...RECONCILE_STATUSES])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(Math.min(maxSignals * 3, 300));
    if (args.channelRowId) {
        query = query.eq('channel_id', args.channelRowId);
    }
    const { data, error } = await query;
    if (error || !data?.length)
        return [];
    const rows = data.filter(r => r.channel_id && r.telegram_message_id);
    const prioritized = openSignalIds
        ? [
            ...rows.filter(r => openSignalIds.has(r.id)
                && signalLooksLikeTeaserBasket(r.parsed_data)),
            ...rows.filter(r => openSignalIds.has(r.id)
                && !signalLooksLikeTeaserBasket(r.parsed_data)),
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
            channel_id: String(row.channel_id),
            telegram_message_id: String(row.telegram_message_id),
            raw_message: row.raw_message ?? '',
            telegram_edit_date_seen: row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
                ? Number(row.telegram_edit_date_seen)
                : null,
            created_at: String(row.created_at ?? ''),
            parsed_data: row.parsed_data ?? null,
        });
        if (out.length >= maxSignals)
            break;
    }
    return out;
}
async function markSignalsReconciled(supabase, args) {
    if (!args.signalIds.length)
        return;
    const now = new Date().toISOString();
    for (const signalId of args.signalIds) {
        const editDate = args.editDateBySignalId?.get(signalId);
        const patch = { telegram_reconciled_at: now };
        if (editDate != null && editDate > 0) {
            patch.telegram_edit_date_seen = Math.floor(editDate);
        }
        await supabase.from('signals').update(patch).eq('id', signalId);
    }
}
