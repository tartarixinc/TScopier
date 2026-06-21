/**
 * Collapse stretched/casual management spellings before deterministic parsing.
 * Channels often hype-type: "breakevennnnn", "noowww", "closeeee".
 */

/** Collapse repeated trailing letters on a stem (keeps stem + one repeat). */
function collapseStem(text: string, stem: string, replacement: string): string {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b${escaped}(\\p{L})\\1{1,}\\b`, 'giu'), replacement)
}

/**
 * Normalize casual management typos so word-boundary regexes match.
 * Scoped to known management verbs only — does not globally collapse letters.
 */
export function collapseCasualSignalTypos(raw: string): string {
  let text = String(raw ?? '')

  text = text.replace(/\bbreakeven(\p{L})\1{1,}\b/giu, 'breakeven')
  text = text.replace(/\bbreak\s*even(\p{L})\1{1,}\b/giu, 'break even')
  text = text.replace(/\bbreak(\p{L})\1{1,}\s*even\b/giu, 'break even')
  text = text.replace(/\bbe+\s+n[o]{1,}w{2,}\b/giu, 'be now')
  text = text.replace(/\bbk+\s+n[o]{1,}w{2,}\b/giu, 'be now')
  text = text.replace(/\bn[o]{1,}w{2,}\b/giu, 'now')
  text = collapseStem(text, 'close', 'close')

  return text
}
