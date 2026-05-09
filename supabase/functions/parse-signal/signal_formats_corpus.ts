/**
 * Paste representative Telegram signal messages your channels send.
 *
 * - Used only when the LLM parses a message (fast deterministic paths skip this).
 * - Separate different styles with a line containing only --- (three dashes).
 * - Use dummy prices/volumes where needed; never store API keys or full account IDs.
 * - Length is capped at SIGNAL_FORMAT_CORPUS_MAX_CHARS when sent (see parse-signal).
 */

export const SIGNAL_FORMAT_CORPUS_MAX_CHARS = 14_000

export const SIGNAL_FORMAT_CORPUS = `
--- Example: concise gold market ---
PAIR: XAUUSD
SIDE: BUY
ENTRY: MARKET NOW
SL: 2635.50
TP1: 2640
TP2: 2645

SIGNAL ALERT

SELL XAUUSD 4724.5

🤑TP1: 4722.5
🤑TP2: 4720.5
🤑TP3: 4712.5
🔴SL: 4736.5

SIGNAL ALERT

BUY XAUUSD 4724.5

🤑TP1: 4726.5
🤑TP2: 4728.5
🤑TP3: 4732.5
🔴SL: 4719.5

BUY BTCUSD 96500

🤑TP1: 96520
🤑TP2: 96540
🤑TP3: 96560
🔴SL: 96480

BUY GOLD NOW
GOLD BUY NOW

BUY BTCUSD NOW
SELL BTCUSD NOW



--- Example: crypto abbreviations ---
🔥 BTC long now
Bitcoin / USDT
SL below 96500 — TP 98500 / 99500

--- Example: close / partial wording ---
Secure 50% and move SL to BE
CLOSE HALF GOLD

CLOSE NOW

CLOSE ALL NOW

--- Add your real channel snippets below (keep --- separators between styles) ---


`.trim()

/** Non-empty body to append into the system prompt (may be truncated). */
export function formatCorpusForSystemPrompt(): string {
  const raw = SIGNAL_FORMAT_CORPUS.trim()
  if (!raw) return ""
  const sliced = raw.length > SIGNAL_FORMAT_CORPUS_MAX_CHARS
    ? raw.slice(0, SIGNAL_FORMAT_CORPUS_MAX_CHARS) + "\n…(truncated — shorten signal_formats_corpus.ts)"
    : raw
  return (
    "\n\n## Reference: example signal layouts (match new messages to these patterns where applicable)\n\n" +
    sliced
  )
}
