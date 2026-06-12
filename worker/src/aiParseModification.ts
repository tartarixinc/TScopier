/**
 * OpenAI-powered parse for modification / management Telegram messages.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedSignal } from './manualPlanning/types'
import {
  normalizeAiParsedOutput,
  parseModificationDeterministic,
  type ChannelKeywords,
  type ParseChannelMessageResult,
} from './parseSignal'
import { getChannelParseContext } from './channelKeywordsCache'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

export type AiModificationIntent =
  | 'modify'
  | 'close'
  | 'breakeven'
  | 'partial_profit'
  | 'parameter_refresh'
  | 'ignore'
  | 'commentary'

export type AiModificationResult = {
  parsed: ParsedSignal
  status: 'parsed' | 'skipped' | 'error'
  skip_reason?: string | null
  intent: AiModificationIntent
  typo_corrected: boolean
  confidence: number
  source: 'deterministic' | 'openai'
}

export type AiModificationContext = {
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
  channel_keywords_summary?: Record<string, string>
}

function aiModificationParseEnabled(): boolean {
  const v = String(process.env.AI_MODIFICATION_PARSE_ENABLED ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

function aiModel(): string {
  return String(process.env.AI_MODIFICATION_PARSE_MODEL ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini'
}

function aiTimeoutMs(): number {
  return Math.max(500, Math.min(15_000, Number(process.env.AI_MODIFICATION_PARSE_TIMEOUT_MS ?? 3500)))
}

function deterministicFastPathConfidence(parsed: { confidence?: number }): number {
  return typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? parsed.confidence
    : 0
}

function keywordsSummary(keywords: ChannelKeywords): Record<string, string> {
  return {
    buy: keywords.signal.buy,
    sell: keywords.signal.sell,
    sl: keywords.signal.sl,
    tp: keywords.signal.tp,
    close_full: keywords.update.close_full,
    break_even: keywords.update.break_even,
    set_sl: keywords.update.set_sl,
    adjust_sl: keywords.update.adjust_sl,
    set_tp: keywords.update.set_tp,
  }
}

function toParseResult(
  parsed: ParsedSignal,
  status: 'parsed' | 'skipped',
  skipReason: string | null,
): ParseChannelMessageResult {
  return {
    parsed: parsed as ParseChannelMessageResult['parsed'],
    status,
    skip_reason: skipReason,
  }
}

function resultFromDeterministic(
  det: ParseChannelMessageResult,
): AiModificationResult | null {
  if (det.status !== 'parsed' || det.parsed.action === 'ignore') return null
  if (deterministicFastPathConfidence(det.parsed) < 0.9) return null
  return {
    parsed: det.parsed as ParsedSignal,
    status: 'parsed',
    skip_reason: null,
    intent: mapActionToIntent(det.parsed.action),
    typo_corrected: false,
    confidence: deterministicFastPathConfidence(det.parsed),
    source: 'deterministic',
  }
}

function mapActionToIntent(action: string): AiModificationIntent {
  const a = String(action ?? '').toLowerCase()
  if (a === 'modify') return 'modify'
  if (a === 'close' || a === 'close_worse_entries') return 'close'
  if (a === 'breakeven' || a === 'partial_breakeven') return 'breakeven'
  if (a === 'partial_profit') return 'partial_profit'
  if (a === 'buy' || a === 'sell') return 'parameter_refresh'
  if (a === 'ignore') return 'ignore'
  return 'commentary'
}

async function loadParentSignal(
  supabase: SupabaseClient,
  parentSignalId: string | null | undefined,
): Promise<AiModificationContext['parent_signal']> {
  if (!parentSignalId) return null
  const { data } = await supabase
    .from('signals')
    .select('raw_message,parsed_data')
    .eq('id', parentSignalId)
    .maybeSingle()
  if (!data) return null
  return {
    raw_message: String((data as { raw_message?: string }).raw_message ?? ''),
    parsed_data: (data as { parsed_data?: Record<string, unknown> }).parsed_data ?? null,
  }
}

async function loadRecentChannelSignals(
  supabase: SupabaseClient,
  args: { userId: string; channelRowId: string; limit?: number },
): Promise<NonNullable<AiModificationContext['recent_signals']>> {
  const { data } = await supabase
    .from('signals')
    .select('raw_message,parsed_data,created_at')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelRowId)
    .eq('status', 'parsed')
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 5)
  return (data ?? []).map(row => ({
    raw_message: String((row as { raw_message?: string }).raw_message ?? ''),
    parsed_data: (row as { parsed_data?: Record<string, unknown> }).parsed_data ?? null,
    created_at: String((row as { created_at?: string }).created_at ?? ''),
  }))
}

const AI_SYSTEM_PROMPT = `You interpret Telegram trading-channel modification/management messages for a trade copier.
Return strict JSON only with keys:
{
  "intent": "modify" | "close" | "breakeven" | "partial_profit" | "parameter_refresh" | "ignore" | "commentary",
  "action": "buy" | "sell" | "modify" | "close" | "close_worse_entries" | "breakeven" | "partial_profit" | "partial_breakeven" | "ignore",
  "symbol": string | null,
  "entry_price": number | null,
  "entry_zone_low": number | null,
  "entry_zone_high": number | null,
  "sl": number | null,
  "tp": number[],
  "lot_size": number | null,
  "partial_close_fraction": number | null,
  "re_enter": boolean,
  "typo_corrected": boolean,
  "confidence": number,
  "corrected_message": string | null
}
Rules:
- Use parent_signal and recent_signals to infer symbol/direction when the reply omits them.
- Correct obvious typos in labels/prices (mov sl, 265O) but never invent prices not implied by the message.
- parameter_refresh: same trade SL/TP update — use buy/sell matching parent direction with sl/tp only (no new entry).
- commentary/TP-hit announcements without actionable instruction → action ignore, intent commentary.
- re_enter true only when message clearly opens a new trade.
- confidence 0-1.`

async function callOpenAiModification(context: AiModificationContext): Promise<Record<string, unknown> | null> {
  if (!OPENAI_API_KEY) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), aiTimeoutMs())
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiModel(),
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data?.choices?.[0]?.message?.content ?? ''
    if (!content) return null
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildAiResult(
  raw: Record<string, unknown>,
  rawMessage: string,
): AiModificationResult {
  const corrected = typeof raw.corrected_message === 'string' && raw.corrected_message.trim()
    ? raw.corrected_message.trim()
    : rawMessage
  const parsed = normalizeAiParsedOutput(
    {
      action: raw.action,
      symbol: raw.symbol,
      entry_price: raw.entry_price,
      entry_zone_low: raw.entry_zone_low,
      entry_zone_high: raw.entry_zone_high,
      sl: raw.sl,
      tp: raw.tp,
      lot_size: raw.lot_size,
      partial_close_fraction: raw.partial_close_fraction,
      re_enter: raw.re_enter,
      confidence: raw.confidence,
      raw_instruction: corrected,
    },
    corrected,
  ) as ParsedSignal

  const intentRaw = String(raw.intent ?? mapActionToIntent(parsed.action))
  const intent = (
    ['modify', 'close', 'breakeven', 'partial_profit', 'parameter_refresh', 'ignore', 'commentary'] as const
  ).includes(intentRaw as AiModificationIntent)
    ? intentRaw as AiModificationIntent
    : mapActionToIntent(parsed.action)

  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0.85

  if (parsed.action === 'ignore' || intent === 'commentary' || intent === 'ignore') {
    return {
      parsed,
      status: 'skipped',
      skip_reason: 'AI classified as non-actionable',
      intent: intent === 'commentary' ? 'commentary' : 'ignore',
      typo_corrected: raw.typo_corrected === true,
      confidence,
      source: 'openai',
    }
  }

  return {
    parsed,
    status: 'parsed',
    skip_reason: null,
    intent,
    typo_corrected: raw.typo_corrected === true,
    confidence,
    source: 'openai',
  }
}

function fallbackIgnore(rawMessage: string, reason: string): AiModificationResult {
  return {
    parsed: {
      action: 'ignore',
      symbol: null,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: null,
      lot_size: null,
      raw_instruction: rawMessage,
    },
    status: 'skipped',
    skip_reason: reason,
    intent: 'ignore',
    typo_corrected: false,
    confidence: 0,
    source: 'deterministic',
  }
}

export async function buildAiModificationContext(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelRowId: string
    rawMessage: string
    isReply?: boolean
    parentSignalId?: string | null
    revision?: AiModificationContext['revision']
  },
): Promise<AiModificationContext> {
  const { keywords } = await getChannelParseContext(supabase, args.channelRowId)
  const [parent_signal, recent_signals] = await Promise.all([
    loadParentSignal(supabase, args.parentSignalId),
    loadRecentChannelSignals(supabase, {
      userId: args.userId,
      channelRowId: args.channelRowId,
    }),
  ])
  return {
    raw_message: args.rawMessage,
    is_reply: args.isReply,
    revision: args.revision,
    parent_signal,
    recent_signals,
    channel_keywords_summary: keywordsSummary(keywords),
  }
}

export async function aiParseModification(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelRowId: string
    rawMessage: string
    isReply?: boolean
    parentSignalId?: string | null
    revision?: AiModificationContext['revision']
    /** When true, skip deterministic fast-path (revisions always use AI). */
    forceAi?: boolean
  },
): Promise<AiModificationResult> {
  const { keywords, lexicon } = await getChannelParseContext(supabase, args.channelRowId)

  if (!args.forceAi) {
    const det = parseModificationDeterministic(args.rawMessage, keywords, lexicon)
    const fast = resultFromDeterministic(det)
    if (fast) return fast
  }

  if (!aiModificationParseEnabled() || !OPENAI_API_KEY) {
    const det = parseModificationDeterministic(args.rawMessage, keywords, lexicon)
    if (det.status === 'parsed' && det.parsed.action !== 'ignore') {
      return {
        parsed: det.parsed as ParsedSignal,
        status: 'parsed',
        skip_reason: null,
        intent: mapActionToIntent(det.parsed.action),
        typo_corrected: false,
        confidence: deterministicFastPathConfidence(det.parsed),
        source: 'deterministic',
      }
    }
    if (args.revision) {
      return fallbackIgnore(args.rawMessage, 'AI unavailable for message revision')
    }
    return fallbackIgnore(args.rawMessage, det.skip_reason ?? 'Modification parse failed')
  }

  const context = await buildAiModificationContext(supabase, args)
  const aiRaw = await callOpenAiModification(context)
  if (!aiRaw) {
    const det = parseModificationDeterministic(args.rawMessage, keywords, lexicon)
    if (det.status === 'parsed' && det.parsed.action !== 'ignore') {
      return {
        parsed: det.parsed as ParsedSignal,
        status: 'parsed',
        skip_reason: null,
        intent: mapActionToIntent(det.parsed.action),
        typo_corrected: false,
        confidence: deterministicFastPathConfidence(det.parsed),
        source: 'deterministic',
      }
    }
    if (args.revision) {
      return fallbackIgnore(args.rawMessage, 'AI request failed for message revision')
    }
    return fallbackIgnore(args.rawMessage, 'AI modification parse failed')
  }

  return buildAiResult(aiRaw, args.rawMessage)
}

/** Convert AI result to parse result shape used by listener dispatch. */
export function aiResultToParseResult(result: AiModificationResult): ParseChannelMessageResult {
  return toParseResult(result.parsed, result.status === 'parsed' ? 'parsed' : 'skipped', result.skip_reason ?? null)
}
