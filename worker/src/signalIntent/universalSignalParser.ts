/**
 * Unified AI parser: extracts language-independent TradeIntent from any Telegram signal.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  enrichParsedKeywordMatch,
  parseChannelMessageSync,
  parseModificationDeterministic,
  type ChannelKeywords,
  type ChannelLexiconRow,
  type ChannelParsedSignal,
  type ParseChannelMessageResult,
} from '../parseSignal'
import { getChannelParseContext } from '../channelKeywordsCache'
import { buildAiModificationContext } from '../aiParseModification'
import { coerceMgmtSlTpFollowUpAction } from '../aiParseModification'
import { coerceAiEntrySignal } from '../aiParseEntry'
import type { ParsedSignal } from '../manualPlanning/types'
import { evaluateParsedSignalExecutionEligibility } from '../signalExecutionEligibility'
import { parsedMissesLabeledEntry } from '../signalEntryNowRequirement'
import { isManagementAction, parsedAction } from '../tradeSignalActions'
import { coerceTradeIntent } from './coerceTradeIntent'
import {
  formatExamplesForPrompt,
  loadChannelSignalExamples,
} from './loadChannelExamples'
import {
  cerebrasParseApiKeys,
  cerebrasParseEnabled,
  cerebrasParseMaxTokens,
  cerebrasParseModel,
  cerebrasParseRetries,
  getUniversalParseMode,
  isUniversalParseEnabled,
  universalParseFastPathConfidence,
  universalParseModel,
  universalParseReconcileModel,
  universalParseReconcileTimeoutMs,
  universalParseStoreIntent,
  universalParseTimeoutMs,
} from './parseConfig'
import { tradeIntentToChannelParsedSignal, withStoredIntent } from './tradeIntentAdapter'
import type { TradeIntent } from './tradeIntent'
import { validateTradeIntent } from './validateTradeIntent'
import { loadOpenTradesForChannel } from '../signalModificationGrounding'
import { formatFewShots, STAGE_TWO_FEW_SHOTS, STAGE_THREE_FEW_SHOTS } from './fewShotExamples'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

/** Per-key Cerebras pool state. `exhausted` means the key hit its daily token
 *  quota ("Tokens per day limit exceeded") — it is skipped for the rest of the
 *  process lifetime, since the quota only resets once per day. */
const cerebrasKeyState = new Map<string, { exhausted: boolean }>()
let cerebrasKeyCursor = 0

function maskKey(key: string): string {
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}...${key.slice(-4)}`
}

/** True for the daily-quota 429 (tokens or requests per day). Unlike transient
 *  rate limits this never recovers within the process lifetime, so the key must
 *  be swapped rather than retried. */
export function isCerebrasDailyLimit(status: number, body: string): boolean {
  return status === 429 && /per day limit/i.test(body)
}

/** Rotation order of pool indices to try, starting at `startIndex` and skipping
 *  keys already marked exhausted. Exported for tests. */
export function cerebrasKeyOrder(
  startIndex: number,
  keys: string[],
  isExhausted: (key: string) => boolean,
): number[] {
  if (keys.length === 0) return []
  const start = ((startIndex % keys.length) + keys.length) % keys.length
  const order: number[] = []
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length
    if (!isExhausted(keys[idx])) order.push(idx)
  }
  return order
}

export type UniversalParseResult = {
  parseResult: ParseChannelMessageResult
  intent: TradeIntent
  source: 'cerebras' | 'openai' | 'gpt4o' | 'unavailable'
  skip_reason?: string | null
  /** When the primary stage-2 provider (Cerebras) failed and the result was
   *  produced by the OpenAI fallback, this carries the Cerebras failure. */
  fallback_reason?: string | null
}

export type UniversalParseContext = {
  raw_message: string
  is_reply?: boolean
  revision?: {
    prior_raw_message: string
    prior_parsed_data: Record<string, unknown> | null
  }
  parent_signal?: {
    raw_message: string
    parsed_data: Record<string, unknown> | null
  } | null
  recent_signals?: Array<{
    raw_message: string
    parsed_data: Record<string, unknown> | null
    created_at: string
  }>
  /** The user's OPEN trades for this channel — ground truth for modifications. */
  open_trades?: Array<{ symbol: string; direction: string }>
  channel_keywords_summary?: Record<string, string>
  channel_examples?: unknown[]
}

const UNIVERSAL_SYSTEM_PROMPT = `You extract trading intent from Telegram channel messages in ANY language.
Return strict JSON only matching this schema:
{
  "kind": "entry" | "modify" | "close" | "breakeven" | "partial_close" | "cancel_pending" | "ignore" | "commentary" | "uncertain",
  "side": "BUY" | "SELL" | null,
  "symbol": string | null,
  "entry": number[],
  "sl": number | null,
  "tp": number[],
  "sl_unit": "price" | "pips",
  "tp_unit": "price" | "pips",
  "flags": {
    "market_now": boolean,
    "re_enter": boolean,
    "open_tp": boolean,
    "partial_close_fraction": number | null
  },
  "confidence": number,
  "detected_language": string | null
}
Rules:
- Extract TRADING INTENT, never translate the message literally.
- Map instrument aliases: GOLD, OR, XAU-USD, XAU/USD → XAUUSD; SILVER → XAGUSD.
- Never invent prices not present in the message.
- New trade entries: kind entry, side BUY or SELL, entry as [price] or zone [low, high].
- SL/TP updates on open trades: kind modify (keep side from parent/recent context when omitted).
- For modification messages (modify/close/breakeven/partial_close), the target symbol MUST match an entry in open_trades when open_trades is present. Never pick a symbol that has no open trade.
- Full close: kind close. Move SL to entry: kind breakeven. Partial close: kind partial_close.
- Cancel/delete buy/sell limit or pending, or "trade invalid" / "setup invalid": kind cancel_pending (not a full market close).
- TP-hit announcements, status updates, "TP2 reached", ATUALIZAÇÃO without new entry → kind commentary or ignore.
- Conditional tense, retrospective discussion, macro news → kind commentary.
- If the message could be an executable trade but the instruction, side, price, or intent is genuinely ambiguous → kind uncertain.
- confidence 0-1.

${formatFewShots(STAGE_TWO_FEW_SHOTS)}`

const RECONCILE_SYSTEM_PROMPT = `You are the final arbiter in a two-stage signal verification pipeline for Telegram trading signals.
A deterministic keyword engine (stage 1) and a previous LLM (stage 2) disagreed about the message, or stage 2 was uncertain, or stage 2 invented values.
Return strict JSON only matching this schema:
{
  "kind": "entry" | "modify" | "close" | "breakeven" | "partial_close" | "cancel_pending" | "ignore" | "commentary" | "uncertain",
  "side": "BUY" | "SELL" | null,
  "symbol": string | null,
  "entry": number[],
  "sl": number | null,
  "tp": number[],
  "sl_unit": "price" | "pips",
  "tp_unit": "price" | "pips",
  "flags": {
    "market_now": boolean,
    "re_enter": boolean,
    "open_tp": boolean,
    "partial_close_fraction": number | null
  },
  "confidence": number,
  "detected_language": string | null
}
Rules:
- Resolve the disagreement using the RAW message as the only source of truth.
- Never invent prices, sides, or stop-losses that are not present in the message. Invented values from stage 2 must be rejected.
- Extract TRADING INTENT, never translate the message literally.
- Map instrument aliases: GOLD, OR, XAU-USD, XAU/USD → XAUUSD; SILVER → XAGUSD.
- TP-hit announcements, status updates, results, recaps, and "target reached" posts without a new entry → kind commentary or ignore.
- A price-range post such as "XAUUSD 4276 To 4256" with no side, no SL, and no entry instruction is a target/analysis post → kind commentary.
- For modification messages, the target symbol MUST match an entry in open_trades when open_trades is present. Never target a symbol with no open trade.
- If the message could be an executable trade but the instruction, side, price, or intent is genuinely ambiguous after reconciliation → kind uncertain (a human will review).
- confidence 0-1.

${formatFewShots(STAGE_THREE_FEW_SHOTS)}`

function keywordsSummary(keywords: ChannelKeywords): Record<string, string> {
  return {
    skip: keywords.additional.skip_keyword,
    ignore: keywords.additional.ignore_keyword,
    entry: keywords.signal.entry_point,
    buy: keywords.signal.buy,
    sell: keywords.signal.sell,
    sl: keywords.signal.sl,
    tp: keywords.signal.tp,
    market: keywords.signal.market_order,
  }
}

async function callChatCompletions(args: {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  userContent: string
  timeoutMs: number
  label: string
  maxTokens?: number
  retries?: number
}): Promise<{ raw: Record<string, unknown> | null; error: string | null; dailyExhausted?: boolean }> {
  if (!args.apiKey) {
    return { raw: null, error: `${args.label} API key not set on listener worker` }
  }
  const maxTokens = args.maxTokens ?? 500
  const attempts = (args.retries ?? 0) + 1
  let lastError: string | null = null
  let dailyExhausted = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const res = await fetch(`${args.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: args.model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: args.systemPrompt },
            { role: 'user', content: args.userContent },
          ],
        }),
        signal: controller.signal,
      })
      // 429 (rate limit) and 5xx are transient — retry with backoff before
      // falling back to the next provider. Previously a single 429 silently
      // degraded the whole stage-2 to the weaker OpenAI fallback model.
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => '')
        lastError = `${args.label} HTTP ${res.status}: ${body.slice(0, 200)}`
        // Daily quota is exhausted — retrying the same key cannot succeed, the
        // caller must rotate to the next key (or fall back to OpenAI).
        dailyExhausted = isCerebrasDailyLimit(res.status, body)
        if (dailyExhausted) break
        if (attempt < attempts) {
          console.warn(`[universalSignalParser] ${args.label} HTTP ${res.status} — retry ${attempt}/${attempts}`)
          await new Promise(r => setTimeout(r, 400 * attempt))
          continue
        }
        break
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        lastError = `${args.label} HTTP ${res.status}: ${body.slice(0, 200)}`
        break
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = data?.choices?.[0]?.message?.content ?? ''
      if (!content) {
        lastError = `empty ${args.label} response`
        break
      }
      try {
        return { raw: JSON.parse(content) as Record<string, unknown>, error: null }
      } catch {
        lastError = `${args.label} returned invalid JSON: ${content.slice(0, 200)}`
        break
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg.includes('abort') ? `${args.label} timeout after ${args.timeoutMs}ms` : msg
      if (attempt < attempts && !msg.includes('abort')) {
        console.warn(`[universalSignalParser] ${args.label} error — retry ${attempt}/${attempts}: ${lastError}`)
        await new Promise(r => setTimeout(r, 400 * attempt))
        continue
      }
      break
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastError) {
    console.error(`[universalSignalParser] ${args.label} failed: ${lastError}`)
  }
  return { raw: null, error: lastError, ...(dailyExhausted ? { dailyExhausted: true } : {}) }
}

function callOpenAiUniversal(context: UniversalParseContext): ReturnType<typeof callChatCompletions> {
  return callChatCompletions({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: OPENAI_API_KEY,
    model: universalParseModel(),
    systemPrompt: UNIVERSAL_SYSTEM_PROMPT,
    userContent: JSON.stringify(context),
    timeoutMs: universalParseTimeoutMs(),
    label: 'OpenAI',
    retries: 1,
  })
}

/** Try every configured Cerebras key, rotating past daily-exhausted keys.
 *  Only falls through to OpenAI (in callStageTwo) when every key failed. */
async function callCerebrasUniversal(context: UniversalParseContext): Promise<{
  raw: Record<string, unknown> | null
  error: string | null
}> {
  const keys = cerebrasParseApiKeys()
  if (keys.length === 0) {
    return { raw: null, error: 'Cerebras API key not set on listener worker' }
  }
  let lastError: string | null = null
  const startIndex = cerebrasKeyCursor
  const order = cerebrasKeyOrder(
    startIndex,
    keys,
    key => cerebrasKeyState.get(key)?.exhausted ?? false,
  )
  if (order.length === 0) {
    return {
      raw: null,
      error: `Cerebras daily token limit exhausted on all ${keys.length} configured keys`,
    }
  }
  for (const idx of order) {
    const key = keys[idx]
    const attempt = await callChatCompletions({
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: key,
      model: cerebrasParseModel(),
      systemPrompt: UNIVERSAL_SYSTEM_PROMPT,
      userContent: JSON.stringify(context),
      timeoutMs: universalParseTimeoutMs(),
      label: `Cerebras[${idx}]`,
      maxTokens: cerebrasParseMaxTokens(),
      retries: cerebrasParseRetries(),
    })
    if (attempt.raw) {
      return { raw: attempt.raw, error: null }
    }
    lastError = attempt.error
    if (attempt.dailyExhausted) {
      cerebrasKeyState.set(key, { exhausted: true })
      console.warn(
        `[universalSignalParser] Cerebras[${idx}] daily limit exhausted (${maskKey(key)}) — rotating to next key`,
      )
      continue
    }
    console.warn(
      `[universalSignalParser] Cerebras[${idx}] failed (${maskKey(key)}), trying next key: ${attempt.error}`,
    )
  }
  // Always advance the rotation start, success or not, so every turn leads with
  // a different key and load spreads evenly across the pool.
  cerebrasKeyCursor = (startIndex + 1) % keys.length
  return { raw: null, error: lastError }
}

/** Stage 2 provider: Cerebras OSS when configured, otherwise OpenAI. */
async function callStageTwo(context: UniversalParseContext): Promise<{
  raw: Record<string, unknown> | null
  error: string | null
  provider: 'cerebras' | 'openai' | null
  fallbackReason?: string | null
}> {
  if (cerebrasParseEnabled() && cerebrasParseApiKeys().length > 0) {
    const cerebras = await callCerebrasUniversal(context)
    if (cerebras.raw) return { ...cerebras, provider: 'cerebras' }
    console.warn(`[universalSignalParser] Cerebras failed, falling back to OpenAI: ${cerebras.error}`)
    const openai = await callOpenAiUniversal(context)
    if (openai.raw) return { ...openai, provider: 'openai', fallbackReason: cerebras.error }
    return { raw: null, error: `${cerebras.error} | ${openai.error}`, provider: null }
  }
  const openai = await callOpenAiUniversal(context)
  return { ...openai, provider: openai.raw ? 'openai' : null }
}

function intentToLegacyParsed(
  intent: TradeIntent,
  rawMessage: string,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal {
  let parsed = tradeIntentToChannelParsedSignal(intent, rawMessage)
  if (intent.kind === 'entry' && (parsed.action === 'buy' || parsed.action === 'sell')) {
    parsed = coerceAiEntrySignal(parsed as ParsedSignal) as ChannelParsedSignal
  }
  if (intent.kind === 'modify') {
    parsed = coerceMgmtSlTpFollowUpAction(parsed as ParsedSignal, 'modify') as ChannelParsedSignal
  }
  return enrichParsedKeywordMatch(parsed, rawMessage, channelKeywords)
}

function buildSkipResult(rawMessage: string, skipReason: string): UniversalParseResult {
  const intent: TradeIntent = {
    kind: 'ignore',
    side: null,
    symbol: null,
    entry: [],
    sl: null,
    tp: [],
    sl_unit: 'price',
    tp_unit: 'price',
    flags: {},
    confidence: 0,
  }
  return {
    intent,
    source: 'unavailable',
    skip_reason: skipReason,
    parseResult: {
      parsed: tradeIntentToChannelParsedSignal(intent, rawMessage),
      status: 'skipped',
      skip_reason: skipReason,
    },
  }
}

/** Shared post-processing for stage 2 (Cerebras/OpenAI) and stage 3 (GPT-4o) raw JSON. */
function finalizeIntent(
  raw: Record<string, unknown>,
  rawMessage: string,
  keywords: ChannelKeywords,
  source: UniversalParseResult['source'],
): UniversalParseResult {
  let intent = coerceTradeIntent(raw)
  const validation = validateTradeIntent(intent, rawMessage)
  intent = validation.intent

  if (!validation.ok) {
    return {
      intent,
      source,
      skip_reason: validation.reason,
      parseResult: {
        parsed: tradeIntentToChannelParsedSignal(intent, rawMessage),
        status: 'skipped',
        skip_reason: validation.reason,
      },
    }
  }

  if (intent.kind === 'commentary' || intent.kind === 'ignore' || intent.kind === 'uncertain') {
    return {
      intent,
      source,
      skip_reason: 'AI classified as non-actionable',
      parseResult: {
        parsed: tradeIntentToChannelParsedSignal(intent, rawMessage),
        status: 'skipped',
        skip_reason: intent.kind === 'uncertain'
          ? 'AI classified as uncertain; human review required'
          : 'AI classified as non-actionable',
      },
    }
  }

  let parsed = intentToLegacyParsed(intent, rawMessage, keywords)
  const eligibility = evaluateParsedSignalExecutionEligibility(parsed, rawMessage, keywords)
  if ((parsed.action === 'buy' || parsed.action === 'sell') && !eligibility.eligible) {
    return {
      intent,
      source,
      skip_reason: eligibility.skipReason ?? 'entry_not_execution_eligible',
      parseResult: {
        parsed,
        status: 'skipped',
        skip_reason: eligibility.skipReason ?? 'entry_not_execution_eligible',
      },
    }
  }

  if (universalParseStoreIntent()) {
    parsed = withStoredIntent(parsed, intent)
  }

  return {
    intent,
    source,
    skip_reason: null,
    parseResult: {
      parsed,
      status: parsed.action === 'ignore' ? 'skipped' : 'parsed',
      skip_reason: parsed.action === 'ignore' ? 'AI classified as non-actionable' : null,
    },
  }
}

export async function buildUniversalParseContext(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelRowId: string
    rawMessage: string
    isReply?: boolean
    parentSignalId?: string | null
    revision?: UniversalParseContext['revision']
    isModificationClass?: boolean
  },
): Promise<UniversalParseContext> {
  const { keywords } = await getChannelParseContext(supabase, args.channelRowId)
  const [base, examples, openTrades] = await Promise.all([
    buildAiModificationContext(supabase, {
      userId: args.userId,
      channelRowId: args.channelRowId,
      rawMessage: args.rawMessage,
      isReply: args.isReply,
      parentSignalId: args.parentSignalId,
      revision: args.revision,
    }),
    loadChannelSignalExamples(supabase, args.channelRowId),
    args.isModificationClass === true
      ? loadOpenTradesForChannel(supabase, { userId: args.userId, channelRowId: args.channelRowId })
      : Promise.resolve([]),
  ])
  return {
    ...base,
    ...(openTrades && openTrades.length > 0 ? { open_trades: openTrades } : {}),
    channel_keywords_summary: keywordsSummary(keywords),
    channel_examples: formatExamplesForPrompt(examples),
  }
}

export async function parseUniversalSignal(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelRowId: string
    rawMessage: string
    isReply?: boolean
    parentSignalId?: string | null
    revision?: UniversalParseContext['revision']
    isModificationClass?: boolean
  },
): Promise<UniversalParseResult> {
  if (!isUniversalParseEnabled() || getUniversalParseMode() === 'off') {
    return buildSkipResult(args.rawMessage, 'universal_parse_disabled')
  }

  const { keywords } = await getChannelParseContext(supabase, args.channelRowId)
  const context = await buildUniversalParseContext(supabase, args)
  const { raw, error, provider, fallbackReason } = await callStageTwo(context)

  if (!raw || !provider) {
    return buildSkipResult(args.rawMessage, error ?? 'universal_parse_unavailable')
  }

  const result = finalizeIntent(raw, args.rawMessage, keywords, provider)
  if (fallbackReason) result.fallback_reason = fallbackReason
  return result
}

/** Stage 3: GPT-4o reconciliation when stage 1 and stage 2 disagree or validation trips. */
export async function reconcileUniversalSignal(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelRowId: string
    rawMessage: string
    isReply?: boolean
    parentSignalId?: string | null
    revision?: UniversalParseContext['revision']
    isModificationClass?: boolean
  },
  stageInput: {
    deterministic: ParseChannelMessageResult
    stage2: UniversalParseResult
    reason: string | null
    openTrades?: Array<{ symbol: string; direction: string }>
  },
): Promise<UniversalParseResult> {
  if (!OPENAI_API_KEY) {
    return buildSkipResult(args.rawMessage, 'reconcile_unavailable')
  }
  const { keywords } = await getChannelParseContext(supabase, args.channelRowId)
  const context = await buildUniversalParseContext(supabase, args)
  const openTrades = stageInput.openTrades ?? context.open_trades ?? []
  const userContent = JSON.stringify({
    ...context,
    ...(openTrades.length > 0 ? { open_trades: openTrades } : {}),
    verification: {
      stage1_deterministic: stageInput.deterministic.status === 'parsed'
        ? stageInput.deterministic.parsed
        : null,
      stage2_llm_intent: stageInput.stage2.intent,
      stage2_reason: stageInput.reason ?? null,
    },
  })
  const { raw, error } = await callChatCompletions({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: OPENAI_API_KEY,
    model: universalParseReconcileModel(),
    systemPrompt: RECONCILE_SYSTEM_PROMPT,
    userContent,
    timeoutMs: universalParseReconcileTimeoutMs(),
    label: 'OpenAI reconcile',
  })
  if (!raw) {
    return buildSkipResult(args.rawMessage, error ?? 'reconcile_unavailable')
  }
  return finalizeIntent(raw, args.rawMessage, keywords, 'gpt4o')
}

export function parseDeterministicForUniversal(
  rawMessage: string,
  keywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null,
  isModificationClass: boolean,
): ParseChannelMessageResult {
  if (isModificationClass) {
    return parseModificationDeterministic(rawMessage, keywords, lexicon)
  }
  return parseChannelMessageSync(rawMessage, keywords, lexicon)
}

export function deterministicQualifiesForFastPath(
  det: ParseChannelMessageResult,
  rawMessage: string,
  keywords: ChannelKeywords,
): boolean {
  if (det.status !== 'parsed' || det.parsed.action === 'ignore') return false
  const conf = typeof det.parsed.confidence === 'number' ? det.parsed.confidence : 0
  if (conf < universalParseFastPathConfidence()) return false

  const action = parsedAction(det.parsed)
  if (isManagementAction(action)) return true

  if (action === 'buy' || action === 'sell') {
    if (!evaluateParsedSignalExecutionEligibility(det.parsed, rawMessage, keywords).eligible) return false
    // If the message labels an entry the parser missed, do not fast-lane; let the AI repair it.
    if (parsedMissesLabeledEntry(det.parsed, rawMessage)) return false
    return true
  }
  return false
}

/** Legacy bridge: convert universal result using same path as old AI parsers. */
export function universalResultToParseResult(result: UniversalParseResult): ParseChannelMessageResult {
  return result.parseResult
}
