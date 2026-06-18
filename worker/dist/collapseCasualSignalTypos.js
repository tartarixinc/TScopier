"use strict";
/**
 * Collapse stretched/casual management spellings before deterministic parsing.
 * Channels often hype-type: "breakevennnnn", "noowww", "closeeee".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.collapseCasualSignalTypos = collapseCasualSignalTypos;
/** Collapse repeated trailing letters on a stem (keeps stem + one repeat). */
function collapseStem(text, stem, replacement) {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`\\b${escaped}(\\p{L})\\1{1,}\\b`, 'giu'), replacement);
}
/**
 * Normalize casual management typos so word-boundary regexes match.
 * Scoped to known management verbs only — does not globally collapse letters.
 */
function collapseCasualSignalTypos(raw) {
    let text = String(raw ?? '');
    // breakevennnnn → breakeven
    text = text.replace(/\bbreakeven(\p{L})\1{1,}\b/giu, 'breakeven');
    // break evennn / breakkk even → break even
    text = text.replace(/\bbreak\s*even(\p{L})\1{1,}\b/giu, 'break even');
    text = text.replace(/\bbreak(\p{L})\1{1,}\s*even\b/giu, 'break even');
    // be nowww / bk nowww (stretched "now" needs 2+ w's so bare "now" in entries is untouched)
    text = text.replace(/\bbe+\s+n[o]{1,}w{2,}\b/giu, 'be now');
    text = text.replace(/\bbk+\s+n[o]{1,}w{2,}\b/giu, 'be now');
    // noowwwww / nowww → now
    text = text.replace(/\bn[o]{1,}w{2,}\b/giu, 'now');
    // closeeee / closse → close (management verb only at word start)
    text = collapseStem(text, 'close', 'close');
    return text;
}
