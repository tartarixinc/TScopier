import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""

type ParsedSignal = {
  action?: string
  symbol?: string | null
  entry_price?: number | null
  entry_zone_low?: number | null
  entry_zone_high?: number | null
  sl?: number | null
  tp?: number[]
  confidence?: number
}

type ChannelProfile = {
  signal_type: string
  tp_style: string
  sl_style: string
  entry_type: string
  most_traded_asset: string | null
  estimated_tp_pips: number | null
  estimated_sl_pips: number | null
  analysis_summary: string
  sample_size: number
  meta: Record<string, unknown>
}

type SignalTrainingSchema = {
  entry_cues: string[]
  buy_cues: string[]
  sell_cues: string[]
  stop_loss_cues: string[]
  take_profit_cues: string[]
  take_profit_tier_cues: string[]
  management_cues: string[]
  signal_order_pattern: "signal_then_price" | "price_then_signal" | "mixed" | "unknown"
  signal_requires_price: boolean | null
  language_hints: string[]
  sample_signal_examples: string[]
  notes: string
}

const FX_QUOTES = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD"])
const KNOWN_SYMBOL_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD",
  XAU: "XAUUSD",
  SILVER: "XAGUSD",
  XAG: "XAGUSD",
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
}

function normalizeAssetSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null
  const token = raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!token) return null

  if (KNOWN_SYMBOL_ALIASES[token]) return KNOWN_SYMBOL_ALIASES[token]

  if (/^(XAUUSD|XAGUSD|US30|NAS100|SPX500|GER40|UK100|BTCUSDT|ETHUSDT)$/.test(token)) {
    return token
  }

  // Forex pairs only when quote is a valid FX quote currency.
  if (/^[A-Z]{6}$/.test(token)) {
    const base = token.slice(0, 3)
    const quote = token.slice(3, 6)
    if (FX_QUOTES.has(base) && FX_QUOTES.has(quote) && base !== quote) {
      return token
    }
  }

  return null
}

function parseFromRawMessage(message: string): ParsedSignal {
  const text = (message ?? "").trim()
  const lower = text.toLowerCase()
  const action =
    /\bbuy|long\b/i.test(lower) ? "buy"
      : /\bsell|short\b/i.test(lower) ? "sell"
        : /\bclose\b/i.test(lower) ? "close"
          : /\bsl|stop\s*loss|tp|take\s*profit\b/i.test(lower) ? "modify"
            : "unknown"
  const symbolMatch = text.match(/\b(XAUUSD|XAGUSD|US30|NAS100|SPX500|GER40|UK100|BTCUSDT|ETHUSDT|[A-Z]{6}|GOLD|SILVER|XAU|XAG|BTC|ETH)\b/i)
  const symbol = normalizeAssetSymbol(symbolMatch ? symbolMatch[1] : null)
  const entryMatch = text.match(/(?:@|entry)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const rangeMatch = text.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/)
  const slMatch = text.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const tpMatches = [...text.matchAll(/\b(?:tp\d*|take\s*profit)\s*[:=]?\s*(\d+(?:\.\d+)?)/gi)]
  return {
    action,
    symbol,
    entry_price: entryMatch ? Number(entryMatch[1]) : null,
    entry_zone_low: rangeMatch ? Number(rangeMatch[1]) : null,
    entry_zone_high: rangeMatch ? Number(rangeMatch[2]) : null,
    sl: slMatch ? Number(slMatch[1]) : null,
    tp: tpMatches.map(m => Number(m[1])).filter(Number.isFinite),
  }
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function inferTpAliases(rows: Array<{ raw_message: string }>): string[] {
  const labels = new Set<string>()
  for (const row of rows) {
    const msg = String(row.raw_message ?? "")
    if (/\btarget\s*\d*\b/i.test(msg)) labels.add("target")
    if (/\btake\s*profit\b/i.test(msg)) labels.add("take profit")
    if (/\btp\d*\b/i.test(msg)) labels.add("tp")
  }
  return Array.from(labels)
}

function inferActionAliases(rows: Array<{ raw_message: string }>): Record<string, string[]> {
  const map: Record<string, Set<string>> = {
    close: new Set<string>(),
    modify: new Set<string>(),
    partial_profit: new Set<string>(),
    breakeven: new Set<string>(),
  }
  for (const row of rows) {
    const msg = String(row.raw_message ?? "").toLowerCase()
    if (/\b(flatten|exit)\b/.test(msg)) map.close.add("exit")
    if (/\b(adjust|revise|update)\b/.test(msg)) map.modify.add("update")
    if (/\b(target\s*1|tp1)\b/.test(msg)) map.partial_profit.add("tp1")
    if (/\b(target\s*2|tp2)\b/.test(msg)) map.partial_profit.add("tp2")
    if (/\b(breakeven|break\s*even|sl\s+to\s+entry)\b/.test(msg)) map.breakeven.add("breakeven")
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.from(v)]))
}

function cleanTokens(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) return []
  const out = new Set<string>()
  for (const token of tokens) {
    const value = String(token ?? "").trim().toLowerCase()
    if (!value) continue
    out.add(value)
  }
  return Array.from(out)
}

const NON_LANGUAGE_HINT_TERMS = new Set<string>([
  "forex",
  "fx",
  "crypto",
  "cryptocurrency",
  "gold",
  "xau",
  "xag",
  "btc",
  "eth",
  "indices",
  "index",
  "commodities",
  "stocks",
  "xauusd",
  "eurusd",
  "gbpusd",
])

function cleanLanguageHints(tokens: unknown): string[] {
  const hints = cleanTokens(tokens)
  const out = new Set<string>()
  for (const hint of hints) {
    if (NON_LANGUAGE_HINT_TERMS.has(hint)) continue
    out.add(hint)
  }
  return Array.from(out)
}

function normalizeTrainingSchema(raw: unknown): SignalTrainingSchema {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const orderRaw = String(src.signal_order_pattern ?? "unknown")
  const signal_order_pattern = (
    orderRaw === "signal_then_price"
    || orderRaw === "price_then_signal"
    || orderRaw === "mixed"
    || orderRaw === "unknown"
  ) ? orderRaw : "unknown"
  const signal_requires_price = typeof src.signal_requires_price === "boolean"
    ? src.signal_requires_price
    : null
  return {
    entry_cues: cleanTokens(src.entry_cues),
    buy_cues: cleanTokens(src.buy_cues),
    sell_cues: cleanTokens(src.sell_cues),
    stop_loss_cues: cleanTokens(src.stop_loss_cues),
    take_profit_cues: cleanTokens(src.take_profit_cues),
    take_profit_tier_cues: cleanTokens(src.take_profit_tier_cues),
    management_cues: cleanTokens(src.management_cues),
    signal_order_pattern,
    signal_requires_price,
    language_hints: cleanLanguageHints(src.language_hints),
    sample_signal_examples: cleanTokens(src.sample_signal_examples).slice(0, 8),
    notes: String(src.notes ?? "").trim().slice(0, 1000),
  }
}

function defaultTrainingSchemaFromRows(rows: Array<{ raw_message: string }>): SignalTrainingSchema {
  const buy = new Set<string>([
    "buy", "long", "comprar", "compra", "acheter", "achat", "kupić", "kupno", "kupic",
    "купить", "покупка", "köp", "kopen", "買い", "شراء",
  ])
  const sell = new Set<string>([
    "sell", "short", "venta", "vender", "vendre", "vente", "sprzedać", "sprzedaz",
    "продать", "продажа", "sälj", "verkopen", "売り", "بيع",
  ])
  const entry = new Set<string>([
    "entry", "@", "at", "price", "now", "entrada", "entree", "wejście", "вход",
    "maintenant", "immédiat", "immediat", "ahora", "inmediato", "teraz", "natychmiast",
    "jetzt", "sofort", "nu", "omedelbart", "onmiddellijk", "сейчас", "немедленно",
    "今すぐ", "即時", "成行", "الآن",
  ])
  const sl = new Set<string>([
    "sl", "stop loss", "stoploss", "stop", "стоп", "stopa", "stopp", "損切り",
  ])
  const tp = new Set<string>([
    "tp", "take profit", "target", "objetivo", "objectif", "cel", "цель", "mål", "doel",
  ])
  const tpTier = new Set<string>(["tp1", "tp2", "tp3", "objetivo 1", "target 1"])
  const management = new Set<string>([
    "breakeven", "break even", "partial", "close", "cerrar", "fermer", "zamknij", "закрыть",
  ])
  const languageHints = new Set<string>()
  const sampleSignalExamples: string[] = []
  let signalThenPrice = 0
  let priceThenSignal = 0

  for (const row of rows.slice(0, 120)) {
    const msg = String(row.raw_message ?? "").trim()
    if (!msg) continue
    const low = msg.toLowerCase()
    if (/[a-z]/.test(low)) languageHints.add("latin")
    if (/\b(comprar|venta|acheter|vendre|kupić|kupno|sprzedać|купить|продать|köp|sälj|kopen|verkopen)\b/.test(low)) {
      languageHints.add("multilingual")
    }
    if (/\b(comprar|venta|acheter|vendre)\b/.test(low)) languageHints.add("romance")
    if (/\b(купить|продать)\b/.test(low)) languageHints.add("cyrillic")
    if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(msg)) languageHints.add("japanese")
    if (/[\u0600-\u06ff]/.test(msg)) languageHints.add("arabic")
    if (sampleSignalExamples.length < 6 && (
      /\b(buy|sell|long|short|tp|sl|entry|comprar|venta|acheter|vendre|kupić|sprzedać|купить|продать)\b/i.test(msg)
      || /\b\d{1,5}(?:\.\d{1,5})\b/.test(msg)
    )) {
      sampleSignalExamples.push(msg.slice(0, 200))
    }
    if (/\b(tp\d+|target\s*\d+)\b/i.test(msg)) tpTier.add("tp1")
    const firstPriceIdx = msg.search(/\d+(?:\.\d+)?/)
    const firstSignalIdx = msg.search(/\b(buy|sell|long|short)\b/i)
    if (firstPriceIdx >= 0 && firstSignalIdx >= 0) {
      if (firstSignalIdx < firstPriceIdx) signalThenPrice += 1
      else priceThenSignal += 1
    }
  }

  const signal_order_pattern = signalThenPrice > 0 && priceThenSignal > 0
    ? "mixed"
    : signalThenPrice > 0
      ? "signal_then_price"
      : priceThenSignal > 0
        ? "price_then_signal"
        : "unknown"

  return {
    entry_cues: Array.from(entry),
    buy_cues: Array.from(buy),
    sell_cues: Array.from(sell),
    stop_loss_cues: Array.from(sl),
    take_profit_cues: Array.from(tp),
    take_profit_tier_cues: Array.from(tpTier),
    management_cues: Array.from(management),
    signal_order_pattern,
    signal_requires_price: null,
    language_hints: Array.from(languageHints),
    sample_signal_examples: sampleSignalExamples,
    notes: "",
  }
}

function pipSize(symbolRaw: string | null, price: number): number {
  const symbol = (symbolRaw ?? "").toUpperCase()
  if (symbol.includes("JPY")) return 0.01
  if (symbol.includes("XAU") || symbol.includes("XAG")) return price >= 100 ? 0.1 : 0.01
  if (price < 10) return 0.0001
  return 0.01
}

function average(values: number[]): number | null {
  if (!values.length) return null
  const total = values.reduce((a, b) => a + b, 0)
  return Number((total / values.length).toFixed(4))
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return Number(sorted[mid].toFixed(4))
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4))
}

function heuristicProfile(rows: Array<{ raw_message: string; parsed_data: unknown }>): ChannelProfile {
  const actionCounts = new Map<string, number>()
  const symbolCounts = new Map<string, number>()
  const entryCounts = { none: 0, single: 0, range: 0 }
  let noTp = 0
  let singleTp = 0
  let multiTp = 0
  let slPresent = 0
  const tp1Pips: number[] = []
  const tp2Pips: number[] = []
  const tp3Pips: number[] = []
  const slPips: number[] = []

  for (const row of rows) {
    const parsed = (row.parsed_data ?? parseFromRawMessage(row.raw_message)) as ParsedSignal
    const action = (parsed.action ?? "unknown").toLowerCase()
    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1)

    const normalizedSymbol = normalizeAssetSymbol(parsed.symbol ?? null)
    if (normalizedSymbol) {
      const sym = normalizedSymbol
      symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1)
    }

    const zoneLow = asNumber(parsed.entry_zone_low)
    const zoneHigh = asNumber(parsed.entry_zone_high)
    const entry = asNumber(parsed.entry_price)
    const sl = asNumber(parsed.sl)
    const tp = Array.isArray(parsed.tp) ? parsed.tp.map(asNumber).filter((v): v is number => v != null) : []

    if (zoneLow != null && zoneHigh != null) entryCounts.range += 1
    else if (entry != null) entryCounts.single += 1
    else entryCounts.none += 1

    if (!tp.length) noTp += 1
    else if (tp.length === 1) singleTp += 1
    else multiTp += 1
    if (sl != null) slPresent += 1

    const anchorEntry = entry ?? (zoneLow != null && zoneHigh != null ? (zoneLow + zoneHigh) / 2 : null)
    if (anchorEntry != null && tp.length) {
      const p = pipSize(normalizedSymbol, anchorEntry)
      const tp1 = Math.abs(tp[0] - anchorEntry) / p
      if (Number.isFinite(tp1)) tp1Pips.push(tp1)
      if (tp.length > 1) {
        const tp2 = Math.abs(tp[1] - anchorEntry) / p
        if (Number.isFinite(tp2)) tp2Pips.push(tp2)
      }
      if (tp.length > 2) {
        const tp3 = Math.abs(tp[2] - anchorEntry) / p
        if (Number.isFinite(tp3)) tp3Pips.push(tp3)
      }
    }
    if (anchorEntry != null && sl != null) {
      const p = pipSize(normalizedSymbol, anchorEntry)
      const slDist = Math.abs(anchorEntry - sl) / p
      if (Number.isFinite(slDist)) slPips.push(slDist)
    }
  }

  const sampleSize = rows.length
  const topAction = [...actionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown"
  const topSymbol = [...symbolCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const entryType =
    (entryCounts.none > 0 ? 1 : 0) + (entryCounts.single > 0 ? 1 : 0) + (entryCounts.range > 0 ? 1 : 0) > 1
      ? "mixed"
      : entryCounts.range > 0
        ? "range"
        : entryCounts.single > 0
          ? "single"
          : "no_entry_price"

  const tpStyle =
    multiTp > 0 && (singleTp > 0 || noTp > 0)
      ? "mixed"
      : multiTp > 0
        ? "tp1_tp2_tp3"
        : singleTp > 0
          ? "single_tp"
          : "no_tp"

  const slStyle =
    slPresent === 0
      ? "no_sl"
      : slPresent < sampleSize
        ? "mixed_sl_usage"
        : "fixed_sl"

  const managementLike =
    (actionCounts.get("modify") ?? 0) +
    (actionCounts.get("breakeven") ?? 0) +
    (actionCounts.get("partial_profit") ?? 0) +
    (actionCounts.get("partial_breakeven") ?? 0)
  const executionLike = (actionCounts.get("buy") ?? 0) + (actionCounts.get("sell") ?? 0)
  const signalType =
    executionLike > 0 && managementLike > 0
      ? "entry_and_management"
      : executionLike > 0
        ? topAction === "buy" || topAction === "sell"
          ? "entry_signals"
          : "mixed"
        : managementLike > 0
          ? "management_only"
          : "unknown"

  return {
    signal_type: signalType,
    tp_style: tpStyle,
    sl_style: slStyle,
    entry_type: entryType,
    most_traded_asset: topSymbol,
    estimated_tp_pips: average(tp1Pips),
    estimated_sl_pips: average(slPips),
    analysis_summary: sampleSize > 0
      ? `Analyzed ${sampleSize} signal messages from last 30 days.`
      : 'No signal messages found in the lookback window. Ensure Telegram is connected and the channel has recent trading posts.',
    sample_size: sampleSize,
    meta: {
      action_counts: Object.fromEntries(actionCounts),
      symbol_counts: Object.fromEntries(symbolCounts),
      entry_counts: entryCounts,
      tp_counts: { no_tp: noTp, single_tp: singleTp, multi_tp: multiTp },
      sl_present_count: slPresent,
      pip_distance: {
        // Keep both mean and median to reduce distortion from outlier calls.
        tp1_avg_pips: average(tp1Pips),
        tp1_median_pips: median(tp1Pips),
        tp1_sample: tp1Pips.length,
        tp2_avg_pips: average(tp2Pips),
        tp2_median_pips: median(tp2Pips),
        tp2_sample: tp2Pips.length,
        tp3_avg_pips: average(tp3Pips),
        tp3_median_pips: median(tp3Pips),
        tp3_sample: tp3Pips.length,
        sl_avg_pips: average(slPips),
        sl_median_pips: median(slPips),
        sl_sample: slPips.length,
      },
    },
  }
}

async function aiEnhanceProfile(
  profile: ChannelProfile,
  rows: Array<{ raw_message: string; parsed_data: unknown }>,
): Promise<Partial<ChannelProfile> | null> {
  if (!OPENAI_API_KEY || !rows.length) return null
  const sample = rows.slice(0, 40).map((r) => ({
    raw_message: r.raw_message,
    parsed_data: r.parsed_data,
  }))
  const prompt = `You are analyzing a Telegram trading signal channel profile.
Return strict JSON only with keys:
{
  "signal_type": string,
  "tp_style": string,
  "sl_style": string,
  "entry_type": string,
  "analysis_summary": string
}
Use these categories when possible:
- signal_type: "entry_signals" | "management_only" | "entry_and_management" | "mixed" | "unknown"
- tp_style: "tp1_tp2_tp3" | "single_tp" | "mixed" | "no_tp"
- sl_style: "fixed_sl" | "mixed_sl_usage" | "no_sl"
- entry_type: "no_entry_price" | "single" | "range" | "mixed"
Keep summary concise (max 220 chars).`
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 220,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            heuristic_profile: profile,
            sample_messages: sample,
          }),
        },
      ],
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content ?? ""
  try {
    const parsed = JSON.parse(content)
    return {
      signal_type: typeof parsed.signal_type === "string" ? parsed.signal_type : undefined,
      tp_style: typeof parsed.tp_style === "string" ? parsed.tp_style : undefined,
      sl_style: typeof parsed.sl_style === "string" ? parsed.sl_style : undefined,
      entry_type: typeof parsed.entry_type === "string" ? parsed.entry_type : undefined,
      analysis_summary: typeof parsed.analysis_summary === "string" ? parsed.analysis_summary : undefined,
    }
  } catch {
    return null
  }
}

async function aiExtractTrainingSchema(
  rows: Array<{ raw_message: string; parsed_data: unknown }>,
): Promise<SignalTrainingSchema | null> {
  if (!OPENAI_API_KEY || !rows.length) return null
  const sample = rows.slice(0, 80).map((r) => String(r.raw_message ?? "").trim()).filter(Boolean)
  const prompt = `You extract per-channel signal training schema for a trading copier.
Return strict JSON only with keys:
{
  "entry_cues": string[],
  "buy_cues": string[],
  "sell_cues": string[],
  "stop_loss_cues": string[],
  "take_profit_cues": string[],
  "take_profit_tier_cues": string[],
  "management_cues": string[],
  "signal_order_pattern": "signal_then_price" | "price_then_signal" | "mixed" | "unknown",
  "signal_requires_price": boolean | null,
  "language_hints": string[],
  "sample_signal_examples": string[],
  "notes": string
}
Rules:
- Include channel-native words/synonyms from any language.
- For "language_hints", include only real languages/scripts (example: "english", "arabic", "latin", "cyrillic").
- Do not include market-domain words (example: "forex", "crypto", "gold") in "language_hints".
- No prose outside JSON.
- Keep arrays deduplicated and concise.`
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ sample_messages: sample }) },
      ],
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content ?? ""
  try {
    return normalizeTrainingSchema(JSON.parse(content))
  } catch {
    return null
  }
}

async function persistTrainingSchema(args: {
  supabase: ReturnType<typeof createClient>
  userId: string
  channelId: string
  training: SignalTrainingSchema
}): Promise<void> {
  const { supabase, userId, channelId, training } = args
  const { data: channelRes } = await supabase
    .from("telegram_channels")
    .select("channel_keywords")
    .eq("id", channelId)
    .eq("user_id", userId)
    .maybeSingle()
  const currentKeywords = channelRes?.channel_keywords && typeof channelRes.channel_keywords === "object"
    ? channelRes.channel_keywords as Record<string, unknown>
    : {}
  const signal = currentKeywords.signal && typeof currentKeywords.signal === "object"
    ? currentKeywords.signal as Record<string, unknown>
    : {}
  const updateSignal = {
    ...signal,
    entry_point: training.entry_cues.join("|") || String(signal.entry_point ?? "ENTRY"),
    buy: training.buy_cues.join("|") || String(signal.buy ?? "BUY"),
    sell: training.sell_cues.join("|") || String(signal.sell ?? "SELL"),
    sl: training.stop_loss_cues.join("|") || String(signal.sl ?? "SL"),
    tp: training.take_profit_cues.join("|") || String(signal.tp ?? "TP"),
  }
  const additional = currentKeywords.additional && typeof currentKeywords.additional === "object"
    ? currentKeywords.additional as Record<string, unknown>
    : {}
  const updatedKeywords = {
    ...currentKeywords,
    signal: updateSignal,
    additional: {
      ...additional,
      ai_signal_order_pattern: training.signal_order_pattern,
      ai_signal_requires_price: training.signal_requires_price,
    },
  }
  await supabase
    .from("telegram_channels")
    .update({ channel_keywords: updatedKeywords })
    .eq("id", channelId)
    .eq("user_id", userId)

  await supabase
    .from("channel_signal_lexicon")
    .upsert({
      user_id: userId,
      channel_id: channelId,
      action_aliases: {
        buy: training.buy_cues,
        sell: training.sell_cues,
        modify: training.management_cues,
      },
      tp_aliases: training.take_profit_tier_cues.length ? training.take_profit_tier_cues : training.take_profit_cues,
      target_aliases: training.take_profit_cues,
      unknown_tokens: training.language_hints,
      updated_at: new Date().toISOString(),
    }, { onConflict: "channel_id" })
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    const { data: authData, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !authData.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    const userId = authData.user.id

    const body = await req.json()
    const action = String(body?.action ?? "analyze")
    const channelId = String(body?.channel_id ?? "")
    const lookbackDays = Math.max(1, Math.min(90, Number(body?.lookback_days ?? 30)))
    const historicalMessages = Array.isArray(body?.historical_messages)
      ? (body.historical_messages as unknown[]).filter((m): m is string => typeof m === "string").slice(0, 300)
      : []
    if (!channelId) return Response.json({ error: "channel_id required" }, { status: 400, headers: corsHeaders })

    const { data: channel } = await supabase
      .from("telegram_channels")
      .select("id,user_id,display_name")
      .eq("id", channelId)
      .eq("user_id", userId)
      .maybeSingle()
    if (!channel) return Response.json({ error: "Channel not found" }, { status: 404, headers: corsHeaders })

    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
    const { data: signals } = await supabase
      .from("signals")
      .select("raw_message,parsed_data")
      .eq("channel_id", channelId)
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500)

    const rows = (signals ?? []) as Array<{ raw_message: string; parsed_data: unknown }>
    const historyRows = historicalMessages.map((raw_message) => ({
      raw_message,
      parsed_data: parseFromRawMessage(raw_message),
    }))
    const mergedRows = [...historyRows, ...rows]
    const heuristic = heuristicProfile(mergedRows)
    const aiPatch = await aiEnhanceProfile(heuristic, mergedRows)
    const finalProfile: ChannelProfile = {
      ...heuristic,
      ...aiPatch,
      sample_size: heuristic.sample_size,
      most_traded_asset: heuristic.most_traded_asset,
      estimated_tp_pips: heuristic.estimated_tp_pips,
      estimated_sl_pips: heuristic.estimated_sl_pips,
      meta: {
        ...heuristic.meta,
        ai_enhanced: Boolean(aiPatch),
        lookback_days: lookbackDays,
      },
    }

    const payload = {
      user_id: userId,
      channel_id: channelId,
      lookback_days: lookbackDays,
      sample_size: finalProfile.sample_size,
      signal_type: finalProfile.signal_type,
      tp_style: finalProfile.tp_style,
      sl_style: finalProfile.sl_style,
      entry_type: finalProfile.entry_type,
      most_traded_asset: finalProfile.most_traded_asset,
      estimated_tp_pips: finalProfile.estimated_tp_pips,
      estimated_sl_pips: finalProfile.estimated_sl_pips,
      analysis_summary: finalProfile.analysis_summary,
      meta: finalProfile.meta,
      analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { data: upserted, error: upsertErr } = await supabase
      .from("channel_signal_profiles")
      .upsert(payload, { onConflict: "channel_id" })
      .select("*")
      .single()
    if (upsertErr) return Response.json({ error: upsertErr.message }, { status: 500, headers: corsHeaders })

    const tpAliases = inferTpAliases(mergedRows)
    const actionAliases = inferActionAliases(mergedRows)
    await supabase
      .from("channel_signal_lexicon")
      .upsert({
        user_id: userId,
        channel_id: channelId,
        action_aliases: actionAliases,
        tp_aliases: tpAliases,
        target_aliases: tpAliases.includes("target") ? ["target"] : [],
        updated_at: new Date().toISOString(),
      }, { onConflict: "channel_id" })

    const symbolCounts =
      finalProfile.meta && typeof finalProfile.meta === "object" && finalProfile.meta.symbol_counts
        && typeof finalProfile.meta.symbol_counts === "object"
        ? finalProfile.meta.symbol_counts as Record<string, number>
        : {}
    const detected_symbols = Object.keys(symbolCounts)
      .map((k) => normalizeAssetSymbol(k) ?? k.toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .filter((s) => s.length > 0)
      .sort((a, b) => (symbolCounts[b] ?? 0) - (symbolCounts[a] ?? 0) || a.localeCompare(b))

    if (action === "save_training") {
      const schema = normalizeTrainingSchema(body?.training_schema)
      await persistTrainingSchema({ supabase, userId, channelId, training: schema })
      await supabase
        .from("channel_signal_profiles")
        .update({
          meta: {
            ...(upserted?.meta && typeof upserted.meta === "object" ? upserted.meta as Record<string, unknown> : {}),
            ai_training_schema: schema,
            ai_training_saved_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("channel_id", channelId)
        .eq("user_id", userId)
      return Response.json({ ok: true, training_schema: schema }, { headers: corsHeaders })
    }

    const trainingSchema = action === "train"
      ? (await aiExtractTrainingSchema(mergedRows) ?? defaultTrainingSchemaFromRows(mergedRows))
      : null
    if (trainingSchema) {
      await persistTrainingSchema({ supabase, userId, channelId, training: trainingSchema })
      await supabase
        .from("channel_signal_profiles")
        .update({
          meta: {
            ...(upserted?.meta && typeof upserted.meta === "object" ? upserted.meta as Record<string, unknown> : {}),
            ai_training_schema: trainingSchema,
            ai_training_trained_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("channel_id", channelId)
        .eq("user_id", userId)
    }

    return Response.json(
      { ok: true, profile: upserted, detected_symbols, ...(trainingSchema ? { training_schema: trainingSchema } : {}) },
      { headers: corsHeaders },
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error"
    return Response.json({ error: msg }, { status: 500, headers: corsHeaders })
  }
})
