"use strict";
/**
 * MT order comment helpers. All copier trades use a `TSCopier:` prefix so open-
 * order reconciliation can find our legs; when a signal has a channel we embed
 * a short channel slug before the signal id.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHANNEL_COMMENT_SLUG_MAX = void 0;
exports.resolveChannelLabelForComment = resolveChannelLabelForComment;
exports.sanitizeChannelCommentSlug = sanitizeChannelCommentSlug;
exports.buildTscopierCommentPrefix = buildTscopierCommentPrefix;
exports.areOrderCommentsEnabled = areOrderCommentsEnabled;
exports.resolveTscopierCommentPrefix = resolveTscopierCommentPrefix;
exports.appendOrderCommentSuffix = appendOrderCommentSuffix;
exports.buildBasketRefreshComment = buildBasketRefreshComment;
/** Max length of the channel slug segment (broker-safe alphanumeric). */
exports.CHANNEL_COMMENT_SLUG_MAX = 12;
/** Resolve the human label used for the comment slug. */
function resolveChannelLabelForComment(displayName, channelUsername) {
    const dn = displayName?.trim();
    if (dn)
        return dn;
    return channelUsername?.trim().replace(/^@/, '') ?? '';
}
/**
 * Strip to characters MT terminals accept in comments (letters and digits only).
 */
function sanitizeChannelCommentSlug(raw) {
    const trimmed = raw.trim().replace(/^@/, '');
    if (!trimmed)
        return '';
    const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '');
    if (alnum.length >= 2)
        return alnum.slice(0, exports.CHANNEL_COMMENT_SLUG_MAX);
    const collapsed = trimmed.replace(/[^a-zA-Z0-9]+/g, '');
    return collapsed.slice(0, exports.CHANNEL_COMMENT_SLUG_MAX) || 'ch';
}
/**
 * Prefix for planner / OrderSend comments.
 * With channel: `TSCopier:ChannelSlug:abc12345`
 * Without: `TSCopier:abc12345`
 */
function buildTscopierCommentPrefix(signalId, channelSlug) {
    const id8 = signalId.slice(0, 8);
    const slug = channelSlug?.trim();
    if (slug)
        return `TSCopier:${slug}:${id8}`;
    return `TSCopier:${id8}`;
}
/** Default on — only explicit `false` disables MT order comments. */
function areOrderCommentsEnabled(manual) {
    return manual?.order_comments_enabled !== false;
}
/**
 * Resolve the comment prefix for a broker after manual settings are known.
 * Returns empty string when order comments are disabled for that channel config.
 */
function resolveTscopierCommentPrefix(signalId, channelSlug, manual, overridePrefix) {
    if (!areOrderCommentsEnabled(manual))
        return '';
    if (overridePrefix != null && overridePrefix !== '')
        return overridePrefix;
    return buildTscopierCommentPrefix(signalId, channelSlug);
}
/** Append a planner suffix (`:tp1`, `:rg2.tp`, …); empty when comments are off. */
function appendOrderCommentSuffix(prefix, suffix) {
    if (!prefix)
        return '';
    return `${prefix}${suffix}`;
}
/** Comment for basket refresh OrderSend when a leg must be re-opened. */
function buildBasketRefreshComment(signalId, manual) {
    if (!areOrderCommentsEnabled(manual))
        return '';
    return `TSCopier:${signalId.slice(0, 8)}:refresh`;
}
