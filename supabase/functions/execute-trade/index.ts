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

async function logExecution(
  supabase: ReturnType<typeof createClient>,
  payload: {
    user_id: string
    signal_id: string
    broker_account_id?: string | null
    action: string
    status: "attempt" | "success" | "failed"
    request_payload?: Record<string, unknown> | null
    response_payload?: unknown
    error_message?: string | null
  },
) {
  try {
    await supabase.from("trade_execution_logs").insert({
      user_id: payload.user_id,
      signal_id: payload.signal_id,
      broker_account_id: payload.broker_account_id ?? null,
      action: payload.action,
      status: payload.status,
      request_payload: payload.request_payload ?? null,
      response_payload: payload.response_payload ?? null,
      error_message: payload.error_message ?? null,
    })
  } catch {
    // Logging should never block execution path.
  }
}

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

function normalizeProviderResult(result: unknown): {
  ticket: string | null
  code: string | null
  state: string | null
  message: string | null
} {
  if (!result || typeof result !== "object") {
    return { ticket: null, code: null, state: null, message: null }
  }
  const r = result as Record<string, unknown>
  return {
    ticket: pickTicket(result),
    code: typeof r.code === "string" ? r.code : null,
    state: typeof r.state === "string" ? r.state : (typeof (r.orderInternal as Record<string, unknown> | undefined)?.state === "string" ? String((r.orderInternal as Record<string, unknown>).state) : null),
    message: typeof r.message === "string" ? r.message : null,
  }
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
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H4',location:'supabase/functions/execute-trade/index.ts:103',message:'execute-trade invoked',data:{hasSignalId:!!signal_id,action:parsed?.action ?? null,hasSymbol:!!parsed?.symbol},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

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
    const requestPayload: Record<string, unknown> = {
      signal_id,
      parsed,
      account_id: accountId,
      broker_account_id: brokerAccount.id,
    }
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id,
      broker_account_id: brokerAccount.id,
      action: parsed.action,
      status: "attempt",
      request_payload: requestPayload,
    })

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
      const normalized = normalizeProviderResult(result)
      const orderTicket = normalized.ticket
      const ticketAsNum = Number(orderTicket)
      const hasValidTicket = orderTicket != null && Number.isFinite(ticketAsNum) && ticketAsNum > 0

      if (!hasValidTicket) {
        const reason = `OrderSend returned no valid ticket. code=${normalized.code ?? 'null'} state=${normalized.state ?? 'null'} message=${normalized.message ?? 'null'}`
        await logExecution(supabase, {
          user_id: signal.user_id,
          signal_id,
          broker_account_id: brokerAccount.id,
          action: parsed.action,
          status: "failed",
          request_payload: requestPayload,
          response_payload: result,
          error_message: reason,
        })
        await supabase.from("signals").update({ status: "failed", skip_reason: reason }).eq("id", signal_id)
        return Response.json({ error: reason, provider: result }, { status: 400, headers: corsHeaders })
      }

      // #region agent log
      fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run2',hypothesisId:'H9',location:'supabase/functions/execute-trade/index.ts:236',message:'ordersend accepted valid ticket',data:{signalId:signal_id,ticket:orderTicket,code:normalized.code,state:normalized.state},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      await logExecution(supabase, {
        user_id: signal.user_id,
        signal_id,
        broker_account_id: brokerAccount.id,
        action: parsed.action,
        status: "success",
        request_payload: requestPayload,
        response_payload: result as Record<string, unknown>,
      })

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
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H5',location:'supabase/functions/execute-trade/index.ts:243',message:'execute-trade caught error',data:{error:message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      const body = await req.clone().json().catch(() => ({})) as { signal_id?: string }
      if (body.signal_id) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        )
        const { data: s } = await supabase.from("signals").select("user_id").eq("id", body.signal_id).maybeSingle()
        await supabase
          .from("signals")
          .update({ status: "failed", skip_reason: message })
          .eq("id", body.signal_id)
        if (s?.user_id) {
          await logExecution(supabase, {
            user_id: s.user_id as string,
            signal_id: body.signal_id,
            action: "unknown",
            status: "failed",
            error_message: message,
          })
        }
      }
    } catch {
      // no-op
    }
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
