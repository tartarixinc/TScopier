import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""

const SYSTEM_PROMPT = `You are a financial trade signal parser. Extract structured trade instructions from Telegram messages.

Return ONLY a JSON object with this exact shape (no markdown, no explanation):
{
  "action": "buy" | "sell" | "close" | "breakeven" | "partial_profit" | "partial_breakeven" | "modify" | "ignore",
  "symbol": string | null,
  "entry_price": number | null,
  "entry_zone_low": number | null,
  "entry_zone_high": number | null,
  "sl": number | null,
  "tp": number[],
  "open_tp": boolean,
  "lot_size": number | null,
  "confidence": number (0-1),
  "raw_instruction": string
}

Rules:
- If optional channel context is appended to the user message (behavior hints for this Telegram source), weigh it as soft guidance — do not refuse to parse if it conflicts with the visible message text.
- If the message contains no trading instruction, set action to "ignore"
- For zone entries like "buy between 1.1200 and 1.1220", set entry_zone_low and entry_zone_high
- For "Set SL to X" or "Move TP to Y" messages, set action to "modify"
- For "Close trade" or "Close all" messages, set action to "close"
- For "Close half / take 50% / partial" together with "breakeven / SL to entry / move stop to BE", set action to "partial_breakeven"
- For "Set breakeven" messages, set action to "breakeven"
- tp is always an array (can have multiple targets)
- Parse target formats as TP too (TP1/2/3, repeated TP lines, Target 1/2/3, Take Profit labels); keep them ordered.
- If the message says open/no TP/runner, set "open_tp" to true.
- confidence reflects how certain you are this is a real trade signal (0 = not a trade, 1 = clear trade)
- symbol must match what the message is about ONLY if that instrument appears in the text (or shorthand like BTC, ETH, GOLD, GU, UJ).
- NEVER default to XAUUSD or GOLD unless the message clearly refers to gold, XAU, or XAUUSD. Crypto (BTC/Bitcoin/Ethereum) uses BTCUSD, BTCUSDT, ETHUSD as appropriate—not gold.
- If the message implies close/modify on an unnamed single position only, symbol may be null (execution may correlate to one open trade).
- if the message contains a broker or server hint, use it to refine the symbol
- if the message contains a slash pair ("EUR/USD"), normalize to EURUSD-style
`

interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[]
  lot_size: number | null
  confidence: number
  raw_instruction: string
  open_tp?: boolean
}

type ChannelLexiconRow = {
  user_id: string
  channel_id: string
  action_aliases?: Record<string, string[]> | null
  tp_aliases?: string[] | null
  target_aliases?: string[] | null
  unknown_tokens?: string[] | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildTpRegex(extraLabels: string[] = []): RegExp {
  const base = ["tp", "take\\s*profit", "target"]
  const custom = extraLabels.map((x) => escapeRegExp(x.trim())).filter(Boolean)
  return new RegExp(`\\b(?:${[...base, ...custom].join("|")})\\s*\\d*\\s*[:=\\-]?\\s*(\\d+(?:\\.\\d+)?)`, "gi")
}

function extractTpLevels(message: string, extraLabels: string[] = []): number[] {
  const text = String(message ?? "")
  const rx = buildTpRegex(extraLabels)
  const matches = [...text.matchAll(rx)]
  const values = matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
  if (values.length) return values
  // Fallback for compact formats like "TP1 4500 TP2 4540" / "Target 1 4500".
  const compact = [...text.matchAll(/\b(?:tp|target)\s*\d+\s+(\d+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
  return compact
}

function detectOpenTp(message: string): boolean {
  const t = String(message ?? "")
  return /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run|leave\s+runner)\b/i.test(t)
}

function isManagementAction(action: string): boolean {
  return new Set(["close", "breakeven", "partial_profit", "partial_breakeven", "modify"]).has(String(action ?? "").toLowerCase())
}

/** Coerce LLM / fast-path output so execute-trade always gets consistent types and confidence. */
function normalizeParsedFromModel(raw: unknown, fallbackText: string): ParsedSignal {
  const j = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  let action = String(j.action ?? "ignore").trim().toLowerCase()
  if (action === "long") action = "buy"
  if (action === "short") action = "sell"
  const allowed = new Set([
    "buy",
    "sell",
    "close",
    "breakeven",
    "partial_profit",
    "partial_breakeven",
    "modify",
    "ignore",
  ])
  if (!allowed.has(action)) action = "ignore"

  const numOrNull = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  let symbol: string | null = null
  if (typeof j.symbol === "string" && j.symbol.trim()) {
    symbol = j.symbol.trim().toUpperCase().replace(/\s+/g, "")
  }

  let tp: number[] = []
  if (Array.isArray(j.tp)) {
    tp = j.tp.map((x) => Number(x)).filter((n) => Number.isFinite(n))
  }

  let confidence = Number(j.confidence)
  // Critical: comparisons like NaN >= 0.7 are false — would skip execution permanently.
  if (!Number.isFinite(confidence)) {
    confidence = action !== "ignore" ? 0.82 : 0
  }
  confidence = Math.min(1, Math.max(0, confidence))

  const raw_instruction =
    typeof j.raw_instruction === "string" && j.raw_instruction.trim().length > 0
      ? j.raw_instruction
      : fallbackText

  return {
    action,
    symbol,
    entry_price: numOrNull(j.entry_price),
    entry_zone_low: numOrNull(j.entry_zone_low),
    entry_zone_high: numOrNull(j.entry_zone_high),
    sl: numOrNull(j.sl),
    tp,
    lot_size: numOrNull(j.lot_size),
    confidence,
    raw_instruction,
    open_tp: Boolean(j.open_tp ?? detectOpenTp(fallbackText)),
  }
}

/** Extract first known instrument ticker from Telegram text (any action). Order: explicit codes → slashes → slang. */
function extractTradableSymbolFromMessage(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const u = raw.toUpperCase().replace(/\s+/g, " ")

  const slash = raw.match(/\b([A-Z]{3,})\s*\/\s*([A-Z]{3,})\b/i)
  if (slash) return (slash[1] + slash[2]).toUpperCase()

  const explicit = u.match(
    /\b(BTCUSD|BTCUSDT|BTCEUR|ETHUSD|ETHUSDT|EURUSD|GBPUSD|USDJPY|AUDUSD|NZDUSD|USDCAD|USDCHF|XAUUSD|XAGUSD|US30|US500|NAS100|GER40|UK100|SPX500|USTEC)\b/,
  )
  if (explicit) return explicit[1]

  if (/\bBITCOIN\b|\bBTC\b/.test(u) && /\bEUR\b/.test(u) && !/\bUSD\b|\bUSDT\b|\bPERP\b/.test(u)) return "BTCEUR"
  if (/\bBITCOIN\b|\bBTC\b/.test(u)) return /\bUSDT\b/.test(u) ? "BTCUSDT" : "BTCUSD"
  if (/\bETHER(EUM)?\b|\bETH\b/.test(u)) return /\bUSDT\b/.test(u) ? "ETHUSDT" : "ETHUSD"
  if (/\b(XAUUSD|XAU\b|GOLD)\b/.test(u)) return "XAUUSD"
  if (/\bSILVER\b|\bXAG\b|\bXAGUSD\b/.test(u)) return "XAGUSD"

  const bogusSix = new Set([
    "CLOSED", "CLOSES", "SIGNAL", "MARKET", "SILVER", "GOLDEN", "MASTER", "PUBLIC", "TRADER", "BROKER",
    "MARGIN", "POSITION", "TRADES", "ORDERS", "ADJUST", "UPDATE", "MODIFY", "CHANGE", "TARGET", "STOPLO",
  ])
  const six = u.match(/\b([A-Z]{6})\b/)
  if (six && !bogusSix.has(six[1])) {
    return six[1]
  }
  return null
}

const ENTRY_KW = /\b(buy|sell|long|short)\b/i
const MGMT_CLOSE = /\b(close\s*(all)?|flatten|kill\s*zones?|exit\s*(trade|position|long|short))\b|\b(close|closed)\s+((my|the|this)\s+)?((running|active|open)\s+)?(trade|position|btc|gold)/i

function parseDeterministicManagement(message: string, lexicon: ChannelLexiconRow | null): ParsedSignal | null {
  const t = message.replace(/\s+/g, " ").trim()
  if (!t) return null
  const tl = t.toLowerCase()

  const sym = extractTradableSymbolFromMessage(t)
  let action: ParsedSignal["action"] | null = null
  let confidence = 0.92

  // Order matters: generic MGMT_CLOSE matches "Close " in "Close half …" — evaluate partial + breakeven first.
  const wantsPartialHalf =
    /\b(partials?|close\s+partials?|close\s+half|close\s+50%|take\s+partials?|take\s+half|take\s+50%|c\s+half|half\s+of\s+(the\s+)?(position|trade))\b/i.test(t) ||
    /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t)
  const wantsBreakeven =
    /\bbreakeven|break\s*even\b/i.test(t) ||
    /\bmoved?\s+(sl\s+)?to\s+(be|entry|entr(y)?\s?price)|\b(be|bk)\s*now\b/i.test(t) ||
    /\bstop\s*loss\s+to\s+(be|entry|breakeven|break\s*even)\b/i.test(t) ||
    /\bsl\s+to\s+(be|entry)\b/i.test(t) ||
    /\bmove\s+.*\b(stop\s*loss|sl)\b.*\b(breakeven|break\s*even|entry|be)\b/i.test(t)

  if (wantsPartialHalf && wantsBreakeven) action = "partial_breakeven"
  else if (wantsPartialHalf) action = "partial_profit"
  else if (wantsBreakeven) action = "breakeven"
  else if (MGMT_CLOSE.test(t)) action = "close"
  else if (
    /\b(set|move|adjust|bring)\s+(sl|tp|target|stop\s*loss|take\s*profit)\b|\b(stop\s*loss|take\s*profit|target)\s*(to|=)\s*[\d.]+/i
      .test(t)
  ) action = "modify"

  if (!action) return null
  const looksEntry = ENTRY_KW.test(t) &&
    /\b(buy|sell)\s+(now|btc|bitcoin|gold|xau)|market\s+(buy|sell)/i.test(t)
  // Avoid swallowing urgent market entries ("Sell now btc") if word "exit" typo — rare skip
  if (action === "close" && /\b(stop\s*sell|sell\s*stops?)\s+now\b/i.test(tl)) return null

  if (action === "close" && looksEntry && /\b(and|&)+\s*(gold|btc)\b/i.test(tl)) {
    confidence = 0.88 // ambiguous
  }

  const slMatch = t.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const sl = slMatch ? Number(slMatch[1]) : null
  const extraTp = [...(lexicon?.tp_aliases ?? []), ...(lexicon?.target_aliases ?? [])]
  const tp = extractTpLevels(t, extraTp)

  return {
    action,
    symbol: sym,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl,
    tp,
    lot_size: null,
    confidence,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
  }
}

/** Fast path: market-ish entries for common assets (gold, btc, …), not gold-only global default. */
function parseSimpleSignal(message: string, lexicon: ChannelLexiconRow | null): ParsedSignal | null {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim()
  if (!text) return null

  if (/\b(close|flatten|exit\s+trade|breakeven|break\s+even|partial|move\s+(sl|tp))\b/i.test(text)) return null

  const isBuy = /\b(buy|long)\b/.test(text)
  const isSell = /\b(sell|short)\b/.test(text)
  const isNow = /\b(now|instant|market|mkt\b)\b/.test(text)
  const atMarketLike = /\b(at\s+market|@\s*market)\b/i.test(message)

  if (!isNow && !atMarketLike) return null
  if (isBuy === isSell) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  // Require commodity/pair-ish context unless we matched a precise 6-letter code
  const hasInstrumentContext =
    /\b(gold|xau|xauusd|btc|bitcoin|btcusd|btcusdt|eth|ethereum|silver|eur|gbp)\b/i.test(text) ||
    /\bEUR\/USD|EURUSD|GBPUSD|USDJPY|XAUUSD|BTCUSD|BTCUSDT\b/i.test(message) ||
    /\b(us30|nas100|ger40|uk100|ustec|spx500)\b/i.test(text) ||
    /^[A-Z]{4,}$/i.test(instrument.trim())

  if (!hasInstrumentContext) return null

  const slMatch = text.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const sl = slMatch ? Number(slMatch[1]) : null
  const extraTp = [...(lexicon?.tp_aliases ?? []), ...(lexicon?.target_aliases ?? [])]
  const tp = extractTpLevels(message, extraTp)

  return {
    action: isBuy ? "buy" : "sell",
    symbol: instrument,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl,
    tp,
    lot_size: null,
    confidence: 0.99,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
  }
}

const MGMT_NON_INSTRUMENT_SYMBOLS = new Set([
  "CHANGE", "CHANGED", "UPDATE", "UPDATED", "MODIFY", "MODIFIED", "ADJUST", "MOVE", "MOVED",
  "CLOSE", "CLOSED", "SIGNAL", "SETUP", "ENTRY", "ZONE", "TRADE", "ORDER", "POSITION",
])

/** Fix LLM hallucination (e.g. XAUUSD on BTC CLOSE) using raw Telegram text. */
function applyRawSymbolRepair(parsed: ParsedSignal, rawMsg: string): ParsedSignal {
  const extracted = extractTradableSymbolFromMessage(rawMsg)

  const cur = parsed.symbol?.toUpperCase().replace(/\s/g, "") ?? ""
  const curMentioned = cur ? new RegExp(`\\b${cur}\\b`, "i").test(rawMsg.replace(/\s+/g, "")) : false
  const goldHints = /\b(gold|xau|xauusd)\b/i.test(rawMsg)
  const btcHints = /\b(btc|bitcoin|btcusd|btcusdt)\b/i.test(rawMsg)
  const hasAnySymbolHint = /([A-Z]{3,}\/[A-Z]{3,})|\b([A-Z]{6}|XAUUSD|XAGUSD|BTCUSD|BTCUSDT|ETHUSD|ETHUSDT)\b|(\bgold\b|\bxau\b|\bbtc\b|\bbitcoin\b|\beth\b|\bether)\b/i
    .test(rawMsg)
  const mgmt = new Set(["close", "breakeven", "partial_profit", "partial_breakeven", "modify"]).has(parsed.action)

  if (mgmt) {
    if (cur && MGMT_NON_INSTRUMENT_SYMBOLS.has(cur)) {
      return { ...parsed, symbol: extracted ?? null }
    }
    if (extracted) return { ...parsed, symbol: extracted }
    // No symbol in management text: prefer null so executor correlates to same-channel open trade.
    if (!hasAnySymbolHint && !curMentioned) return { ...parsed, symbol: null }
    if (cur === "XAUUSD" && !goldHints) return { ...parsed, symbol: null }
    return parsed
  }
  if (!extracted) return parsed
  if (
    cur === "XAUUSD" && (!goldHints && (btcHints || extracted.includes("BTC") || extracted.includes("ETH")))
  ) {
    return { ...parsed, symbol: extracted }
  }
  if ((!cur || cur !== extracted) && (btcHints || goldHints || /^[A-Z]{6}$/.test(extracted))) {
    return { ...parsed, symbol: extracted }
  }
  return parsed
}

function compactChannelProfile(row: Record<string, unknown>): string {
  const parts: string[] = []
  const push = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return
    const s = String(v).trim()
    if (!s || s === "unknown") return
    parts.push(k + "=" + s)
  }
  push("signal_type", row.signal_type)
  push("tp_style", row.tp_style)
  push("sl_style", row.sl_style)
  push("entry_type", row.entry_type)
  push("asset", row.most_traded_asset)
  if (row.estimated_tp_pips != null) push("est_tp_pips", row.estimated_tp_pips)
  if (row.estimated_sl_pips != null) push("est_sl_pips", row.estimated_sl_pips)
  if (typeof row.analysis_summary === "string" && row.analysis_summary.trim()) {
    const sum = row.analysis_summary.trim()
    const summaryBody = sum.length > 600 ? sum.slice(0, 600) + "..." : sum
    parts.push("summary=" + summaryBody)
  }
  return parts.join("; ")
}

async function loadChannelLexicon(
  supabase: ReturnType<typeof createClient>,
  channelId: string | null,
): Promise<ChannelLexiconRow | null> {
  if (!channelId) return null
  const { data } = await supabase
    .from("channel_signal_lexicon")
    .select("user_id, channel_id, action_aliases, tp_aliases, target_aliases, unknown_tokens")
    .eq("channel_id", channelId)
    .maybeSingle()
  return (data ?? null) as ChannelLexiconRow | null
}

function collectUnknownActionTokens(raw: string): string[] {
  const text = String(raw ?? "").toLowerCase()
  const words = text.match(/\b[a-z]{4,}\b/g) ?? []
  const known = new Set([
    "buy", "sell", "long", "short", "close", "modify", "update", "move", "target", "profit", "take", "stop",
    "loss", "entry", "breakeven", "partial", "half", "gold", "bitcoin", "tp", "sl", "market", "now",
  ])
  return Array.from(new Set(words.filter((w) => !known.has(w)).slice(0, 8)))
}

async function upsertLexiconUnknownTokens(
  supabase: ReturnType<typeof createClient>,
  signal: { user_id: string; channel_id: string | null; raw_message: string },
  lexicon: ChannelLexiconRow | null,
) {
  if (!signal.channel_id) return
  const unknown = collectUnknownActionTokens(signal.raw_message)
  if (!unknown.length) return
  const merged = Array.from(new Set([...(lexicon?.unknown_tokens ?? []), ...unknown])).slice(0, 120)
  await supabase
    .from("channel_signal_lexicon")
    .upsert({
      user_id: signal.user_id,
      channel_id: signal.channel_id,
      unknown_tokens: merged,
      updated_at: new Date().toISOString(),
    }, { onConflict: "channel_id" })
}

async function parseWithOpenAI(message: string, channelHints: string | null): Promise<ParsedSignal> {
  const userContent = channelHints
    ? "Channel context (from prior analysis of this source; may be incomplete):\n" +
      channelHints +
      "\n\n---\nMessage to parse:\n" +
      message
    : message
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 400,
    }),
  })

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? ""

  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`Failed to parse OpenAI response: ${content}`)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json()
    const { signal_id } = body
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H3',location:'supabase/functions/parse-signal/index.ts:97',message:'parse-signal invoked',data:{hasSignalId:!!signal_id},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (!signal_id) {
      return Response.json({ error: "signal_id required" }, { status: 400, headers: corsHeaders })
    }

    // Load signal
    const { data: signal, error: signalErr } = await supabase
      .from("signals")
      .select("*")
      .eq("id", signal_id)
      .single()

    if (signalErr || !signal) {
      return Response.json({ error: "Signal not found" }, { status: 404, headers: corsHeaders })
    }

    // Optional channel profile hints (read-only; missing row is fine).
    let channelHints: string | null = null
    const lexicon = await loadChannelLexicon(supabase, signal.channel_id)
    if (signal.channel_id) {
      const { data: prof } = await supabase
        .from("channel_signal_profiles")
        .select(
          "signal_type, tp_style, sl_style, entry_type, most_traded_asset, estimated_tp_pips, estimated_sl_pips, analysis_summary",
        )
        .eq("channel_id", signal.channel_id)
        .maybeSingle()
      if (prof && typeof prof === "object") {
        const hint = compactChannelProfile(prof as Record<string, unknown>)
        if (hint) channelHints = hint
      }
    }

    // Parse message: management + multi-asset deterministic paths first, then LLM.
    const rawParsed =
      parseDeterministicManagement(signal.raw_message, lexicon)
      ?? parseSimpleSignal(signal.raw_message, lexicon)
      ?? await parseWithOpenAI(signal.raw_message, channelHints)
    const parsed = applyRawSymbolRepair(
      normalizeParsedFromModel(rawParsed, signal.raw_message),
      signal.raw_message,
    )

    // Update signal with parsed data
    const newStatus = parsed.action === "ignore" ? "skipped" : "parsed"
    const { error: updateErr } = await supabase
      .from("signals")
      .update({
        parsed_data: parsed,
        status: newStatus,
        skip_reason: parsed.action === "ignore" ? "Non-trade message" : null,
      })
      .eq("id", signal_id)

    if (updateErr) {
      return Response.json({ error: updateErr.message }, { status: 500, headers: corsHeaders })
    }

    EdgeRuntime.waitUntil(upsertLexiconUnknownTokens(supabase, signal, lexicon))

    // If valid trade signal, trigger execution (entries) or enqueue management job.
    if (parsed.action !== "ignore" && parsed.confidence >= 0.7) {
      if (isManagementAction(parsed.action)) {
        EdgeRuntime.waitUntil(
          (async () => {
            try {
              await supabase
                .from("management_jobs")
                .upsert({
                  user_id: signal.user_id,
                  signal_id,
                  channel_id: signal.channel_id ?? null,
                  action: parsed.action,
                  parsed_data: parsed,
                  status: "pending",
                  attempts: 0,
                  max_attempts: 6,
                  next_run_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: "signal_id" })
            } catch (e) {
              console.error("parse-signal enqueue management job error:", e)
            }
          })(),
        )
      } else {
        // Fire-and-forget trade execution for entry signals.
        EdgeRuntime.waitUntil(
          (async () => {
            try {
              // #region agent log
              fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H3',location:'supabase/functions/parse-signal/index.ts:138',message:'execute-trade dispatch',data:{signalId:signal_id,action:parsed.action,confidence:parsed.confidence},timestamp:Date.now()})}).catch(()=>{});
              // #endregion
              const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
              const execRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-trade`, {
                method: "POST",
                headers: {
                  // sb_secret_* is not a JWT; use apikey (Bearer triggers INVALID_JWT_FORMAT on the gateway).
                  "apikey": secret,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ signal_id, parsed }),
              })
              if (!execRes.ok) {
                const raw = await execRes.text()
                // #region agent log
                fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H3',location:'supabase/functions/parse-signal/index.ts:149',message:'execute-trade non-2xx',data:{signalId:signal_id,status:execRes.status,body:raw.slice(0,300)},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
                const reason = `Execute trade failed (${execRes.status}): ${raw.slice(0, 300)}`
                await supabase.from("signals").update({ status: "failed", skip_reason: reason }).eq("id", signal_id)
                console.error("parse-signal execute-trade failed:", reason)
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : "execute-trade network error"
              await supabase.from("signals").update({ status: "failed", skip_reason: msg }).eq("id", signal_id)
              console.error("parse-signal execute-trade error:", msg)
            }
          })()
        )
      }
    }

    return Response.json({ parsed, status: newStatus }, { headers: corsHeaders })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("parse-signal error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
