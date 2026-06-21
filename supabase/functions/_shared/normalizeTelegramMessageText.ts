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

/** Telegram format strip + casual management typo collapse for parsers. */
export function normalizeSignalMessageForParse(raw: string): string {
  return collapseCasualSignalTypos(normalizeTelegramMessageText(raw))
}
