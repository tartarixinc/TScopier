"use strict";
/** Normalize Telegram chat ids to canonical `-100…` form for signal_channels registry. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNumericTelegramChatId = isNumericTelegramChatId;
exports.normalizeTelegramChatId = normalizeTelegramChatId;
exports.toChannelIdVariants = toChannelIdVariants;
function isNumericTelegramChatId(raw) {
    return /^-?\d+$/.test(String(raw ?? '').trim());
}
function normalizeTelegramChatId(raw) {
    const value = String(raw ?? '').trim();
    if (!value || !isNumericTelegramChatId(value))
        return value;
    if (value.startsWith('-100'))
        return value;
    const n = Number(value);
    if (!Number.isFinite(n))
        return value;
    const abs = String(Math.abs(Math.trunc(n)));
    if (value.startsWith('-'))
        return `-100${abs}`;
    return `-100${abs}`;
}
function toChannelIdVariants(raw) {
    const canonical = normalizeTelegramChatId(raw);
    const value = (raw ?? '').trim();
    if (!value)
        return [];
    const out = new Set([value, canonical]);
    const n = Number(value);
    if (!Number.isFinite(n))
        return [...out];
    const abs = String(Math.abs(Math.trunc(n)));
    out.add(abs);
    if (canonical.startsWith('-100')) {
        out.add(canonical.slice(4));
    }
    return [...out];
}
