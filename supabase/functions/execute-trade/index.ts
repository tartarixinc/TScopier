import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""
const METATRADERAPI_BASE = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")

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
}

type QueryValue = string | number | boolean | null | undefined

async function mtGet(path: string, params: Record<string, QueryValue>) {
  const url = new URL(`${METATRADERAPI_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": METATRADERAPI_KEY,
    },
  })
  const raw = await res.text()
  let data: unknown = null
  try { data = JSON.parse(raw) } catch { data = raw }
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "message" in (data as Record<string, unknown>))
      ? String((data as Record<string, unknown>).message)
      : raw
    throw new Error(msg || `Metatrader API error ${res.status}`)
  }
  return data
}

function pickTicket(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  const ticket =
    r.ticket ??
    (r.orderInternal as Record<string, unknown> | undefined)?.ticket ??
    (r.dealInternalIn as Record<string, unknown> | undefined)?.ticketNumber ??
    (r.dealInternalOut as Record<string, unknown> | undefined)?.ticketNumber
  if (ticket === undefined || ticket === null) return null
  return String(ticket)
}

function operationFor(action: string, signalPrice: number | null): string {
  if (action === "buy") return signalPrice != null ? "BuyLimit" : "Buy"
  if (action === "sell") return signalPrice != null ? "SellLimit" : "Sell"
  return "Buy"
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    if (!METATRADERAPI_KEY) {
      return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json()
    const { signal_id, parsed } = body as { signal_id: string; parsed: ParsedSignal }

    if (!signal_id || !parsed) {
      return Response.json({ error: "signal_id and parsed required" }, { status: 400, headers: corsHeaders })
    }

    // Load signal to get user_id
    const { data: signal } = await supabase
      .from("signals")
      .select("user_id, channel_id, is_modification, parent_signal_id")
      .eq("id", signal_id)
      .single()

    if (!signal) {
      return Response.json({ error: "Signal not found" }, { status: 404, headers: corsHeaders })
    }

    // Load broker account
    const { data: brokerAccount } = await supabase
      .from("broker_accounts")
      .select("*")
      .eq("user_id", signal.user_id)
      .eq("is_active", true)
      .maybeSingle()

    if (!brokerAccount) {
      await supabase.from("signals").update({ status: "skipped", skip_reason: "No active broker account" }).eq("id", signal_id)
      return Response.json({ skipped: true, reason: "No active broker account" }, { headers: corsHeaders })
    }

    // Load channel-level overrides
    let pipTolerance = brokerAccount.pip_tolerance
    let lotSize = brokerAccount.default_lot_size

    if (signal.channel_id) {
      const { data: channel } = await supabase
        .from("telegram_channels")
        .select("pip_tolerance_override, lot_size_override")
        .eq("id", signal.channel_id)
        .maybeSingle()

      if (channel?.pip_tolerance_override) pipTolerance = channel.pip_tolerance_override
      if (channel?.lot_size_override) lotSize = channel.lot_size_override
    }

    if (parsed.lot_size) lotSize = parsed.lot_size

    const accountId = brokerAccount.metaapi_account_id as string

    // Simplified baseline: only execute entry signals for now.
    if (parsed.action === "buy" || parsed.action === "sell") {
      if (!parsed.symbol) {
        await supabase.from("signals").update({ status: "skipped", skip_reason: "No symbol detected" }).eq("id", signal_id)
        return Response.json({ skipped: true, reason: "No symbol detected" }, { headers: corsHeaders })
      }

      const signalPrice = parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high
      const operation = operationFor(parsed.action, signalPrice)

      const result = await mtGet("/OrderSend", {
        id: accountId,
        symbol: parsed.symbol,
        operation,
        volume: lotSize,
        price: signalPrice ?? 0,
        slippage: pipTolerance ?? 0,
        stoploss: parsed.sl ?? 0,
        takeprofit: parsed.tp?.[0] ?? 0,
        comment: `TSCopier signal ${signal_id}`,
        expertID: 0,
        stopLimitPrice: 0,
        expirationType: "GTC",
        placedType: "Signal",
      })
      const orderTicket = pickTicket(result)

      // Save trade record
      const { data: tradeRow } = await supabase
        .from("trades")
        .insert({
          user_id: signal.user_id,
          signal_id,
          broker_account_id: brokerAccount.id,
          metaapi_order_id: orderTicket,
          symbol: parsed.symbol,
          direction: parsed.action,
          entry_price: parsed.entry_price ?? parsed.entry_zone_low ?? null,
          sl: parsed.sl,
          tp: parsed.tp?.[0] ?? null,
          lot_size: lotSize,
          status: "open",
          opened_at: new Date().toISOString(),
        })
        .select("id")
        .single()

      await supabase.from("signals").update({ status: "executed" }).eq("id", signal_id)

      return Response.json({ executed: true, trade_id: tradeRow?.id }, { headers: corsHeaders })
    }

    // Non-entry actions intentionally skipped in simplified mode.
    await supabase
      .from("signals")
      .update({ status: "skipped", skip_reason: `Action not executed in simplified mode: ${parsed.action}` })
      .eq("id", signal_id)
    return Response.json({ skipped: true }, { headers: corsHeaders })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("execute-trade error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
