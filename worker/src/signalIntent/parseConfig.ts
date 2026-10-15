export type UniversalParseMode = 'off' | 'shadow' | 'fastpath' | 'primary'

const FASTPATH_CONFIDENCE = 0.99
const CEREBRAS_MODEL = 'gpt-oss-120b'
const RECONCILE_MODEL = 'gpt-4o'
const RECONCILE_TIMEOUT_MS = 8000

export function parseEnvBool(name: string, defaultValue = false): boolean {
  const raw = String(process.env[name] ?? (defaultValue ? 'true' : 'false')).trim()
  const v = raw.replace(/^["']|["']$/g, '').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function isUniversalParseEnabled(): boolean {
  if (parseEnvBool('UNIVERSAL_PARSE_ENABLED', true)) return true
  return getUniversalParseMode() !== 'off'
}

export function getUniversalParseMode(): UniversalParseMode {
  const raw = String(process.env.UNIVERSAL_PARSE_MODE ?? 'shadow').trim().toLowerCase()
  if (raw === 'fastpath' || raw === 'primary' || raw === 'shadow' || raw === 'off') {
    return raw
  }
  return 'shadow'
}

export function universalParseFastPathConfidence(): number {
  const n = Number(process.env.UNIVERSAL_PARSE_FASTPATH_CONFIDENCE ?? FASTPATH_CONFIDENCE)
  return Number.isFinite(n) ? Math.min(1, Math.max(0.5, n)) : FASTPATH_CONFIDENCE
}

/** AI may veto an otherwise parsed deterministic candidate only when enabled. */
export function universalParseAiVetoEnabled(): boolean {
  return parseEnvBool('UNIVERSAL_PARSE_AI_VETO_ENABLED', false)
}

/**
 * Human-review escalation: AI-uncertain signals are held as skips and the user
 * is asked to approve them within a 2-minute window (in-app modal, Telegram
 * nudge, optional email). Deactivated by default — uncertain signals become
 * ordinary "AI classified as non-actionable" skips and nothing asks the user.
 * Set HUMAN_REVIEW_ESCALATION_ENABLED=true to activate it again.
 */
export function humanReviewEscalationEnabled(): boolean {
  return parseEnvBool('HUMAN_REVIEW_ESCALATION_ENABLED', false)
}

export function universalParseModel(): string {
  return String(
    process.env.UNIVERSAL_PARSE_MODEL
    ?? process.env.AI_ENTRY_PARSE_MODEL
    ?? process.env.AI_MODIFICATION_PARSE_MODEL
    ?? 'gpt-4o-mini',
  ).trim() || 'gpt-4o-mini'
}

export function universalParseTimeoutMs(): number {
  return Math.max(500, Math.min(15_000, Number(process.env.UNIVERSAL_PARSE_TIMEOUT_MS ?? 4000)))
}

/** Stage 2 provider: fast OSS model on Cerebras Inference (OpenAI-compatible). */
export function cerebrasParseEnabled(): boolean {
  return parseEnvBool('CEREBRAS_PARSE_ENABLED', true)
}

/** Cerebras API keys for stage 2. Multiple keys distribute the daily token
 *  quota across accounts: once a key returns "Tokens per day limit exceeded",
 *  the pool rotates to the next usable key instead of degrading to OpenAI.
 *  Each key gets its own env var: CEREBRAS_API_KEY_1, CEREBRAS_API_KEY_2, …
 *  (enumerated from 1, stops at the first gap). The legacy CEREBRAS_API_KEY
 *  is only used when no numbered keys are set. */
export function cerebrasParseApiKeys(): string[] {
  const keys: string[] = []
  for (let i = 1; i <= 20; i++) {
    const key = String(process.env[`CEREBRAS_API_KEY_${i}`] ?? '').trim()
    if (!key) break
    keys.push(key)
  }
  if (keys.length > 0) return keys
  const single = String(process.env.CEREBRAS_API_KEY ?? '').trim()
  return single ? [single] : []
}

export function cerebrasParseModel(): string {
  return String(process.env.CEREBRAS_PARSE_MODEL ?? CEREBRAS_MODEL).trim() || CEREBRAS_MODEL
}

/** gpt-oss-120b is a reasoning model — it emits reasoning tokens before content.
 *  A 500-token cap leaves too little room for the JSON answer, causing empty or
 *  truncated content that silently triggers the OpenAI fallback. Default to a
 *  generous budget that comfortably fits reasoning + the JSON payload. */
export function cerebrasParseMaxTokens(): number {
  const n = Number(process.env.CEREBRAS_PARSE_MAX_TOKENS ?? 2000)
  return Number.isFinite(n) ? Math.max(500, Math.min(8000, Math.round(n))) : 2000
}

/** How many attempts to make against Cerebras before falling back to OpenAI.
 *  Cerebras aggressively rate-limits (429) under bursts, so a short retry with
 *  backoff recovers transient limits instead of silently degrading. */
export function cerebrasParseRetries(): number {
  const n = Number(process.env.CEREBRAS_PARSE_RETRIES ?? 2)
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 2
}

/** Stage 3: GPT-4o reconciliation between deterministic and stage-2 results. */
export function universalParseReconcileEnabled(): boolean {
  return parseEnvBool('UNIVERSAL_PARSE_RECONCILE_ENABLED', false)
}

export function universalParseReconcileModel(): string {
  return String(
    process.env.UNIVERSAL_PARSE_RECONCILE_MODEL ?? RECONCILE_MODEL,
  ).trim() || RECONCILE_MODEL
}

export function universalParseReconcileTimeoutMs(): number {
  return Math.max(1000, Math.min(30_000, Number(process.env.UNIVERSAL_PARSE_RECONCILE_TIMEOUT_MS ?? RECONCILE_TIMEOUT_MS)))
}

export function universalParseStoreIntent(): boolean {
  return parseEnvBool('UNIVERSAL_PARSE_STORE_INTENT', true)
}
