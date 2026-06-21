"use strict";
/** MT order comment parsing (worker-side, mirrors src/lib/tscopierComment.ts). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_TSCOPIER_COMMENT_PREFIX = exports.TSCOPIER_COMMENT_PREFIX = void 0;
exports.signalIdMatchesPrefix = signalIdMatchesPrefix;
exports.isTscopierComment = isTscopierComment;
exports.parseTscopierComment = parseTscopierComment;
exports.tscopierCommentMatchesChannelSlug = tscopierCommentMatchesChannelSlug;
exports.TSCOPIER_COMMENT_PREFIX = 'TScopier:';
/** Legacy MT comments written before brand casing was standardized. */
exports.LEGACY_TSCOPIER_COMMENT_PREFIX = 'TSCopier:';
function signalIdMatchesPrefix(signalId, prefix) {
    const norm = prefix.toLowerCase();
    if (norm.length !== 8 || !/^[a-f0-9]+$/.test(norm))
        return false;
    return signalId.toLowerCase().startsWith(norm);
}
/** True when comment uses the current or legacy TScopier order prefix. */
function isTscopierComment(comment) {
    if (!comment?.trim())
        return false;
    const trimmed = comment.trim();
    return (trimmed.startsWith(exports.TSCOPIER_COMMENT_PREFIX)
        || trimmed.startsWith(exports.LEGACY_TSCOPIER_COMMENT_PREFIX));
}
function stripTscopierCommentPrefix(trimmed) {
    if (trimmed.startsWith(exports.TSCOPIER_COMMENT_PREFIX)) {
        return trimmed.slice(exports.TSCOPIER_COMMENT_PREFIX.length);
    }
    if (trimmed.startsWith(exports.LEGACY_TSCOPIER_COMMENT_PREFIX)) {
        return trimmed.slice(exports.LEGACY_TSCOPIER_COMMENT_PREFIX.length);
    }
    return null;
}
/** Parse `TScopier:ChannelSlug:abc12345` or `TScopier:abc12345` from MT order comment. */
function parseTscopierComment(comment) {
    if (!comment?.trim())
        return null;
    const trimmed = comment.trim();
    const body = stripTscopierCommentPrefix(trimmed);
    if (body === null)
        return null;
    const segments = body.split(':').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0)
        return null;
    const id8From = (s) => {
        const m = s.match(/^([a-f0-9]{8})/i);
        return m ? m[1].toLowerCase() : null;
    };
    if (segments.length === 1) {
        const prefix = id8From(segments[0]);
        return prefix ? { channelSlug: null, signalIdPrefix: prefix } : null;
    }
    const firstPrefix = id8From(segments[0]);
    if (firstPrefix) {
        return { channelSlug: null, signalIdPrefix: firstPrefix };
    }
    const secondPrefix = id8From(segments[1] ?? '');
    if (secondPrefix) {
        return { channelSlug: segments[0], signalIdPrefix: secondPrefix };
    }
    return null;
}
/** True when comment belongs to this channel slug (case-insensitive). */
function tscopierCommentMatchesChannelSlug(comment, channelSlug) {
    const slug = channelSlug?.trim();
    if (!slug)
        return true;
    const parsed = parseTscopierComment(comment);
    if (!parsed?.channelSlug)
        return true;
    return parsed.channelSlug.toLowerCase() === slug.toLowerCase();
}
