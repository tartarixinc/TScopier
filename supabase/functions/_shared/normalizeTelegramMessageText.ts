/**
 * Strip Telegram / Markdown / HTML formatting so signal parsers see plain trade text.
 */
import { collapseCasualSignalTypos } from "./collapseCasualSignalTypos.ts"

export function normalizeTelegramMessageText(raw: string): string {
  let text = String(raw ?? "")

  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<\/p>/gi, "\n")
  text = text.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|span)[^>]*>/gi, "")
  text = text.replace(/<a\b[^>]*href=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, "$1")

  text = text.replace(/\|\|([^|]+)\|\|/g, "$1")
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1")
  text = text.replace(/__([^_]+)__/g, "$1")
  text = text.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, "$1")
  text = text.replace(/(?<![*_])_([^_\n]+)_(?![*_])/g, "$1")
  text = text.replace(/~~([^~]+)~~/g, "$1")
  text = text.replace(/`([^`]+)`/g, "$1")

  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")

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
