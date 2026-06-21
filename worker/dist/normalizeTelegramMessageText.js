"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTelegramMessageText = normalizeTelegramMessageText;
exports.normalizeSignalMessageForParse = normalizeSignalMessageForParse;
/**
 * Strip Telegram / Markdown / HTML formatting so signal parsers see plain trade text.
 * Channels often post signals in italic (_text_ or <i>text</i>), which breaks word-boundary regexes.
 */
const collapseCasualSignalTypos_1 = require("./collapseCasualSignalTypos");
function normalizeTelegramMessageText(raw) {
    let text = String(raw ?? '');
    // Preserve line breaks from HTML; collapse other tags.
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|span)[^>]*>/gi, '');
    text = text.replace(/<a\b[^>]*href=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');
    // Telegram MarkdownV2 spoiler ||text||
    text = text.replace(/\|\|([^|]+)\|\|/g, '$1');
    // Bold / italic (order matters: longer markers first)
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, '$1');
    text = text.replace(/(?<![*_])_([^_\n]+)_(?![*_])/g, '$1');
    // Strikethrough, inline code
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.replace(/`([^`]+)`/g, '$1');
    // Decode a few common HTML entities that survive tag stripping
    text = text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
    return text.trim();
}
/** Telegram format strip + casual management typo collapse for parsers. */
function normalizeSignalMessageForParse(raw) {
    return (0, collapseCasualSignalTypos_1.collapseCasualSignalTypos)(normalizeTelegramMessageText(raw));
}
