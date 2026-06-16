"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAiEntryParseEnabled = isAiEntryParseEnabled;
exports.aiEntryResultToParseResult = aiEntryResultToParseResult;
exports.aiParseEntry = aiParseEntry;
const parseSignal_1 = require("./parseSignal");
const channelKeywordsCache_1 = require("./channelKeywordsCache");
const aiParseModification_1 = require("./aiParseModification");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
function parseEnvBool(name, defaultValue = false) {
    const raw = String(process.env[name] ?? (defaultValue ? 'true' : 'false')).trim();
    const v = raw.replace(/^["']|["']$/g, '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
function isAiEntryParseEnabled() {
    return parseEnvBool('AI_ENTRY_PARSE_ENABLED', false);
}
function aiEntryParseEnabled() {
    return isAiEntryParseEnabled();
}
function aiModel() {
    return String(process.env.AI_ENTRY_PARSE_MODEL ?? process.env.AI_MODIFICATION_PARSE_MODEL ?? 'gpt-4o-mini').trim()
        || 'gpt-4o-mini';
}
function aiTimeoutMs() {
    return Math.max(500, Math.min(15000, Number(process.env.AI_ENTRY_PARSE_TIMEOUT_MS ?? 4000)));
}
function keywordsSummary(keywords) {
    return {
        buy: keywords.signal.buy,
        sell: keywords.signal.sell,
        sl: keywords.signal.sl,
        tp: keywords.signal.tp,
        entry: keywords.signal.entry_point,
        market: keywords.signal.market_order,
    };
}
const AI_ENTRY_SYSTEM_PROMPT = `You interpret Telegram trading-channel entry signals for a trade copier.
Return strict JSON only with keys:
{
  "action": "buy" | "sell" | "ignore",
  "symbol": string | null,
  "entry_price": number | null,
  "entry_zone_low": number | null,
  "entry_zone_high": number | null,
  "sl": number | null,
  "tp": number[],
  "lot_size": number | null,
  "open_tp": boolean,
  "re_enter": boolean,
  "confidence": number,
  "corrected_message": string | null
}
Rules:
- Use channel_keywords_summary and recent_signals for channel-native labels in any language.
- Map foreign buy/sell words to action buy or sell.
- Normalize symbols (GOLD→XAUUSD, SILVER→XAGUSD).
- Never invent prices not present in the message.
- Commentary or TP-hit announcements without a new entry → action ignore.
- confidence 0-1.`;
function toParseResult(parsed, status, skip_reason) {
    return { parsed: parsed, status, skip_reason };
}
function aiEntryResultToParseResult(result) {
    return toParseResult(result.parsed, result.status === 'parsed' ? 'parsed' : 'skipped', result.skip_reason ?? null);
}
async function callOpenAiEntry(context) {
    if (!OPENAI_API_KEY) {
        return { raw: null, error: 'OPENAI_API_KEY not set on listener worker' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), aiTimeoutMs());
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
                max_tokens: 450,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: AI_ENTRY_SYSTEM_PROMPT },
                    { role: 'user', content: JSON.stringify(context) },
                ],
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return {
                raw: null,
                error: `OpenAI HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
            };
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        if (!content)
            return { raw: null, error: 'OpenAI returned empty content' };
        return { raw: JSON.parse(content), error: null };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { raw: null, error: msg.includes('abort') ? `OpenAI timeout after ${aiTimeoutMs()}ms` : msg };
    }
    finally {
        clearTimeout(timer);
    }
}
async function aiParseEntry(supabase, args) {
    if (!aiEntryParseEnabled() || !OPENAI_API_KEY) {
        const skipReason = !aiEntryParseEnabled()
            ? 'AI entry parse disabled (AI_ENTRY_PARSE_ENABLED)'
            : 'OPENAI_API_KEY not set on listener worker';
        console.warn(`[aiParseEntry] skip channel=${args.channelRowId}: ${skipReason}`);
        return {
            parsed: {
                action: 'ignore',
                symbol: null,
                entry_price: null,
                entry_zone_low: null,
                entry_zone_high: null,
                sl: null,
                tp: [],
                lot_size: null,
                raw_instruction: args.rawMessage,
            },
            status: 'skipped',
            skip_reason: skipReason,
            confidence: 0,
            source: 'openai',
        };
    }
    const { keywords } = await (0, channelKeywordsCache_1.getChannelParseContext)(supabase, args.channelRowId);
    const baseContext = await (0, aiParseModification_1.buildAiModificationContext)(supabase, {
        userId: args.userId,
        channelRowId: args.channelRowId,
        rawMessage: args.rawMessage,
        isReply: args.isReply,
        parentSignalId: args.parentSignalId,
    });
    const { raw: aiRaw, error: aiError } = await callOpenAiEntry({
        ...baseContext,
        channel_keywords_summary: keywordsSummary(keywords),
        parse_mode: 'entry',
    });
    if (!aiRaw) {
        console.warn(`[aiParseEntry] failed channel=${args.channelRowId}:`, aiError ?? 'unknown error');
        return {
            parsed: {
                action: 'ignore',
                symbol: null,
                entry_price: null,
                entry_zone_low: null,
                entry_zone_high: null,
                sl: null,
                tp: [],
                lot_size: null,
                raw_instruction: args.rawMessage,
            },
            status: 'skipped',
            skip_reason: aiError ?? 'AI entry parse failed',
            confidence: 0,
            source: 'openai',
        };
    }
    const corrected = typeof aiRaw.corrected_message === 'string' && aiRaw.corrected_message.trim()
        ? aiRaw.corrected_message.trim()
        : args.rawMessage;
    const parsed = (0, parseSignal_1.normalizeAiParsedOutput)({
        action: aiRaw.action,
        symbol: aiRaw.symbol,
        entry_price: aiRaw.entry_price,
        entry_zone_low: aiRaw.entry_zone_low,
        entry_zone_high: aiRaw.entry_zone_high,
        sl: aiRaw.sl,
        tp: aiRaw.tp,
        lot_size: aiRaw.lot_size,
        open_tp: aiRaw.open_tp,
        re_enter: aiRaw.re_enter,
        confidence: aiRaw.confidence,
        raw_instruction: corrected,
    }, corrected);
    const confidence = typeof aiRaw.confidence === 'number' && Number.isFinite(aiRaw.confidence)
        ? Math.min(1, Math.max(0, aiRaw.confidence))
        : 0.85;
    if (parsed.action === 'ignore' || parsed.action !== 'buy' && parsed.action !== 'sell') {
        return {
            parsed,
            status: 'skipped',
            skip_reason: 'AI classified as non-entry',
            confidence,
            source: 'openai',
        };
    }
    return {
        parsed,
        status: 'parsed',
        skip_reason: null,
        confidence,
        source: 'openai',
    };
}
