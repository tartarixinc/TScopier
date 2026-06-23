/**
 * Strip Telegram / Markdown / HTML formatting so signal parsers see plain trade text.
 * Channels often post signals in italic (_text_ or <i>text</i>), which breaks word-boundary regexes.
 */
import { collapseCasualSignalTypos } from './collapseCasualSignalTypos'

export function normalizeTelegramMessageText(raw: string): string {
  let text = String(raw ?? '')

  // Preserve line breaks from HTML; collapse other tags.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n')
  text = text.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|span)[^>]*>/gi, '')
  text = text.replace(/<a\b[^>]*href=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')

  // Telegram MarkdownV2 spoiler ||text||
  text = text.replace(/\|\|([^|]+)\|\|/g, '$1')

  // Bold / italic (order matters: longer markers first)
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, '$1')
  text = text.replace(/(?<![*_])_([^_\n]+)_(?![*_])/g, '$1')

  // Strikethrough, inline code
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')

  // Decode a few common HTML entities that survive tag stripping
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')

  return text.trim()
}

/**
 * Remove decorative emoji glued to SL/TP/entry labels (e.g. BUY 🟢4110, TP1 🎯4127, SL ⛔️4104).
 * Parsers match word boundaries and digits; emoji between label and price breaks those regexes.
 */
export function stripSignalDecorativeEmojis(text: string): string {
  return String(text ?? '').replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu,
    '',
  )
}

/** Telegram format strip + casual management typo collapse for parsers. */
export function normalizeSignalMessageForParse(raw: string): string {
  return collapseCasualSignalTypos(stripSignalDecorativeEmojis(normalizeTelegramMessageText(raw)))
}
