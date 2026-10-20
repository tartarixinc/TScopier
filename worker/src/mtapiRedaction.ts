/**
 * Mirror of supabase/functions/_shared/mtapiRedaction.ts for the worker.
 *
 * The MT4 bridge (`mt4rest`) echoes the request headers back inside its
 * "client not found" message, so the `Authorization` API key and the
 * `X-Internal-Token` we send on every call come back to us in the response
 * body. `MtapiApiError` would then carry them into
 * `trade_execution_logs.error_message`, into the worker console (Railway logs)
 * and — via the edge function — into the customer's browser.
 *
 * Redaction happens in the `MtapiApiError` constructor, which is the single
 * choke point every construction site in this runtime passes through, so no
 * consumer can forget to apply it.
 *
 * Keep in sync with `supabase/functions/_shared/mtapiRedaction.ts`.
 */

/** Same rule as `looks_like_secret` in `deploy/mtapi-log-redactor/redact.awk`. */
function looksLikeSecret(value: string): boolean {
  if (value.length < 12) return false
  if (value.length >= 20) return true
  return /[0-9]/.test(value)
}

/**
 * Each source captures (1) the header or scheme name, (2) the separator and
 * (3) the value. The value stops at whitespace or at the `___` the bridge uses
 * to join echoed headers, so a token is never cut short by underscores of its
 * own while trailing prose is left alone.
 *
 * The sources deliberately start without a `\b` word boundary: the `___`
 * separator is made of underscores, which are word characters, so a header
 * sitting right after one (`…https___x-internal-token : …`) has no boundary in
 * front of it and would never match. False positives are excluded by the
 * separator requirement plus `looksLikeSecret`.
 *
 * `bearer` runs first so that `Authorization : Bearer <key>` is handled by the
 * rule that knows about the scheme; the `authorization` source is the fallback
 * for a colon-, equals- or whitespace-joined scheme-less value, and sees only
 * the word `Bearer`
 * left behind at that point. It deliberately stops at the first space, so it
 * does not claim to cover other schemes written as `Basic <value>` — the
 * bridge only ever echoes the `Bearer` scheme we send it.
 */
const CREDENTIAL_SOURCES = [
  '(bearer)([ \\t]*[:=][ \\t]*|[ \\t]+)((?:(?!___)\\S)+?)(?=___|\\s|$)',
  '(x[-_]internal[-_]token)([ \\t]*[:=][ \\t]*|[ \\t]+)((?:(?!___)\\S)+?)(?=___|\\s|$)',
  '(authorization)([ \\t]*[:=][ \\t]*|[ \\t]+)((?:(?!___)\\S)+?)(?=___|\\s|$)',
] as const

/**
 * Replace credential values with `[REDACTED]`, leaving the rest of the message
 * byte-for-byte intact. Safe to call on any string; returns it unchanged when
 * there is nothing to redact.
 */
export function redactBridgeSecrets(message: string): string {
  if (!message) return message
  let out = message
  for (const source of CREDENTIAL_SOURCES) {
    out = out.replace(
      new RegExp(source, 'gi'),
      (_match, name: string, sep: string, raw: string) => {
        const value = String(raw)
        const trimmed = value.trim()
        const quoted = trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
        const core = quoted ? trimmed.slice(1, -1) : trimmed
        if (!looksLikeSecret(core)) return `${name}${sep}${value}`
        return `${name}${sep}${quoted ? '"[REDACTED]"' : '[REDACTED]'}`
      },
    )
  }
  return out
}
