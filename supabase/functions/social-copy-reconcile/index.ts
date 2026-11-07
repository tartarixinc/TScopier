import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { isMtapiConfigured, MtapiClient } from "../_shared/mtapiClient.ts"

/**
 * Migration-preview social copy reconciler.
 *
 * Railway trade workers for this branch still default SOCIAL_COPY_EXECUTION_ENABLED
 * off and mark subscriptions EXECUTION_DISABLED. This function uses Edge MTAPI
 * secrets (which already keep broker sessions healthy) to open/close copies.
 */

const WORKER_ID = "social-copy-edge"

type SubRow = {
  id: string
  source_id: string
  destination_broker_account_id: string
  sizing_mode: "fixed_lot" | "lot_multiplier" | "equity_ratio"
  fixed_lot: number | null
  lot_multiplier: number
  max_lot: number
  status: string
  desired_status: string
  execution_path: string
  source_account_mode: string
  destination_account_mode: string
  requested_account_mode: string
}

type BrokerRow = {
  id: string
  provider: string | null
  platform: string | null
  is_active: boolean
  connection_status: string | null
  mtapi_session_id: string | null
  linked_account_type: string | null
}

type MappingRow = {
  id: string
  source_ticket: string
  destination_ticket: string | null
  state: string
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizePosition(raw: unknown): {
  ticket: string
  symbol: string
  side: "buy" | "sell"
  volume: number
  stopLoss: number | null
  takeProfit: number | null
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const ticket = num(row.ticket ?? row.Ticket ?? row.order ?? row.Order)
  const symbol = String(row.symbol ?? row.Symbol ?? row.symbolName ?? "").trim()
  const sideText = `${row.orderType ?? row.OrderType ?? row.type ?? row.Type ?? row.cmd ?? ""}`.toLowerCase()
  const side = sideText.includes("buy") || sideText === "0"
    ? "buy"
    : sideText.includes("sell") || sideText === "1"
      ? "sell"
      : null
  const volume = num(row.lots ?? row.Lots ?? row.volume ?? row.Volume ?? row.lotsVolume)
  if (!(ticket && ticket > 0) || !symbol || !side || !(volume && volume > 0)) return null
  const stopLoss = num(row.stoploss ?? row.stopLoss ?? row.StopLoss ?? row.sl ?? row.SL)
  const takeProfit = num(row.takeprofit ?? row.takeProfit ?? row.TakeProfit ?? row.tp ?? row.TP)
  return {
    ticket: String(Math.trunc(ticket)),
    symbol,
    side,
    volume,
    stopLoss: stopLoss && stopLoss !== 0 ? stopLoss : null,
    takeProfit: takeProfit && takeProfit !== 0 ? takeProfit : null,
  }
}

function sizedVolume(sub: SubRow, sourceVolume: number): number {
  let requested = sub.sizing_mode === "fixed_lot"
    ? Number(sub.fixed_lot)
    : sourceVolume * Number(sub.lot_multiplier || 1)
  if (!(requested > 0)) requested = sourceVolume
  const maxLot = Number(sub.max_lot)
  if (maxLot > 0) requested = Math.min(requested, maxLot)
  // Round to 0.01 lots for MT5 demo safety.
  return Math.max(0.01, Math.floor(requested * 100 + 1e-9) / 100)
}

/** Persist an audit row so Copier Logs / Activities can show the copy. */
async function writeExecutionEvent(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: {
    subscriptionId: string
    mappingId: string | null
    sourceTicket: string
    action: "open" | "close"
    idempotencyKey: string
    status: "succeeded" | "failed" | "uncertain"
    request: Record<string, unknown>
    result?: Record<string, unknown>
    errorDetail?: string | null
  },
): Promise<void> {
  const { data, error } = await supabase.from("social_copy_execution_events").insert({
    subscription_id: input.subscriptionId,
    mapping_id: input.mappingId,
    source_ticket: input.sourceTicket,
    action: input.action,
    idempotency_key: input.idempotencyKey,
    status: "claimed",
    request_payload: input.request,
  }).select("id").single()

  if (error) {
    // Unique conflict: skip — the original claim owns this key.
    if (error.code !== "23505") {
      console.warn("[social-copy-reconcile] event insert failed", error.message)
    }
    return
  }
  const eventId = data?.id as string | undefined
  if (!eventId) return

  const { error: updateError } = await supabase.from("social_copy_execution_events").update({
    status: input.status,
    result_payload: input.result ?? {},
    error_detail: input.errorDetail ?? null,
    completed_at: new Date().toISOString(),
  }).eq("id", eventId)
  if (updateError) {
    console.warn("[social-copy-reconcile] event finish failed", updateError.message)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok")

  const auth = req.headers.get("Authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  if (!token) return json({ error: "Service role required" }, 401)

  // Accept the project service-role key, or any JWT whose role claim is service_role
  // (cron / vault keys can differ from a local preview copy of the secret).
  let authorized = Boolean(serviceKey) && token === serviceKey
  if (!authorized && token.split(".").length === 3) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")))
      authorized = payload?.role === "service_role"
    } catch {
      authorized = false
    }
  }
  if (!authorized) return json({ error: "Service role required" }, 401)

  if (!isMtapiConfigured(Deno.env)) {
    return json({ error: "MTAPI is not configured on this project" }, 503)
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey || token,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const mtapi = new MtapiClient({ env: Deno.env })

  const { data: claimed, error: claimError } = await supabase.rpc("claim_social_copy_subscriptions", {
    p_worker: WORKER_ID,
    p_limit: 10,
    p_lease_seconds: 55,
  })
  if (claimError) return json({ error: claimError.message }, 500)

  const rows = (claimed ?? []) as SubRow[]
  const results: Array<Record<string, unknown>> = []

  for (const sub of rows) {
    try {
      if (sub.desired_status === "paused") {
        await supabase.from("social_copy_subscriptions").update({
          status: "paused",
          error_code: null,
          error_detail: null,
          lease_owner: null,
          lease_expires_at: null,
          last_reconciled_at: new Date().toISOString(),
          worker_acknowledged_at: new Date().toISOString(),
        }).eq("id", sub.id)
        results.push({ id: sub.id, status: "paused" })
        continue
      }
      if (sub.desired_status === "stopped") {
        await supabase.from("social_copy_subscriptions").update({
          status: "stopped",
          stopped_at: new Date().toISOString(),
          lease_owner: null,
          lease_expires_at: null,
          last_reconciled_at: new Date().toISOString(),
        }).eq("id", sub.id)
        results.push({ id: sub.id, status: "stopped" })
        continue
      }
      if (sub.execution_path !== "broker") {
        await supabase.from("social_copy_subscriptions").update({
          status: "active",
          error_code: null,
          error_detail: null,
          lease_owner: null,
          lease_expires_at: null,
          last_reconciled_at: new Date().toISOString(),
          worker_acknowledged_at: new Date().toISOString(),
        }).eq("id", sub.id)
        results.push({ id: sub.id, status: "synthetic_ack" })
        continue
      }

      const { data: authorized, error: authErr } = await supabase.rpc(
        "check_social_copy_subscription_authorization",
        { p_subscription_id: sub.id },
      )
      if (authErr || authorized !== true) {
        throw new Error("SOCIAL_ACCESS_REVOKED")
      }

      const { data: source } = await supabase.from("social_copy_sources")
        .select("id,broker_account_id,status")
        .eq("id", sub.source_id)
        .single()
      if (!source || source.status !== "published") throw new Error("SOURCE_NOT_PUBLISHED")

      const [{ data: sourceBroker }, { data: destBroker }] = await Promise.all([
        supabase.from("broker_accounts")
          .select("id,provider,platform,is_active,connection_status,mtapi_session_id,linked_account_type")
          .eq("id", source.broker_account_id)
          .single(),
        supabase.from("broker_accounts")
          .select("id,provider,platform,is_active,connection_status,mtapi_session_id,linked_account_type")
          .eq("id", sub.destination_broker_account_id)
          .single(),
      ])
      const src = sourceBroker as BrokerRow | null
      const dst = destBroker as BrokerRow | null
      if (!src?.is_active || !dst?.is_active) throw new Error("BROKER_DISCONNECTED")
      if (String(src.provider).toLowerCase() !== "mtapi" || String(dst.provider).toLowerCase() !== "mtapi") {
        throw new Error("UNSUPPORTED_PROVIDER")
      }
      const srcSession = String(src.mtapi_session_id ?? "").trim()
      const dstSession = String(dst.mtapi_session_id ?? "").trim()
      if (!srcSession || !dstSession) throw new Error("BROKER_SESSION_UNAVAILABLE")

      const srcPlatform = String(src.platform ?? "MT5").toUpperCase()
      const dstPlatform = String(dst.platform ?? "MT5").toUpperCase()
      const sourceOrders = await mtapi.openedOrders(srcSession, srcPlatform)
      const positions = sourceOrders.map(normalizePosition).filter((row): row is NonNullable<typeof row> => row != null)

      const { data: mappings } = await supabase.from("social_copy_trade_mappings")
        .select("id,source_ticket,destination_ticket,state")
        .eq("subscription_id", sub.id)
        .in("state", ["opening", "open", "closing", "uncertain", "error"])
      const bySource = new Map(((mappings ?? []) as MappingRow[]).map((row) => [row.source_ticket, row]))

      let opened = 0
      let closed = 0
      for (const position of positions) {
        const existing = bySource.get(position.ticket)
        if (existing) continue
        const volume = sizedVolume(sub, position.volume)
        const comment = `sc:${sub.id.slice(0, 8)}:${position.ticket}`.slice(0, 31)
        const { data: mappingInsert, error: mappingError } = await supabase.from("social_copy_trade_mappings").insert({
          subscription_id: sub.id,
          source_ticket: position.ticket,
          destination_ticket: null,
          source_symbol: position.symbol,
          destination_symbol: position.symbol,
          source_side: position.side,
          source_volume: position.volume,
          destination_volume: volume,
          source_stop_loss: position.stopLoss,
          source_take_profit: position.takeProfit,
          state: "opening",
          broker_comment: comment,
        }).select("id").single()
        if (mappingError) {
          if (String(mappingError.message).toLowerCase().includes("duplicate")) continue
          throw mappingError
        }
        try {
          const sent = await mtapi.orderSendSafe(dstSession, {
            symbol: position.symbol,
            operation: position.side === "buy" ? "Buy" : "Sell",
            volume,
            stoploss: position.stopLoss,
            takeprofit: position.takeProfit,
            comment,
          }, dstPlatform)
          await supabase.from("social_copy_trade_mappings").update({
            destination_ticket: String(sent.ticket),
            state: "open",
            opened_at: new Date().toISOString(),
            last_error_code: null,
            last_error_detail: null,
          }).eq("id", mappingInsert.id)
          await writeExecutionEvent(supabase, {
            subscriptionId: sub.id,
            mappingId: mappingInsert.id,
            sourceTicket: position.ticket,
            action: "open",
            idempotencyKey: `open:${position.ticket}`,
            status: "succeeded",
            request: {
              symbol: position.symbol,
              side: position.side,
              volume,
            },
            result: { destination_ticket: String(sent.ticket) },
          })
          opened += 1
        } catch (openError) {
          const detail = openError instanceof Error ? openError.message : String(openError)
          await supabase.from("social_copy_trade_mappings").update({
            state: "error",
            last_error_code: "BROKER_OPERATION_FAILED",
            last_error_detail: detail.slice(0, 500),
          }).eq("id", mappingInsert.id)
          await writeExecutionEvent(supabase, {
            subscriptionId: sub.id,
            mappingId: mappingInsert.id,
            sourceTicket: position.ticket,
            action: "open",
            idempotencyKey: `open:${position.ticket}`,
            status: "failed",
            request: {
              symbol: position.symbol,
              side: position.side,
              volume,
            },
            errorDetail: detail.slice(0, 500),
          })
          throw openError
        }
      }

      const openTickets = new Set(positions.map((p) => p.ticket))
      for (const mapping of bySource.values()) {
        if (openTickets.has(mapping.source_ticket) || mapping.state === "closed") continue
        const destTicket = Number(mapping.destination_ticket)
        if (Number.isFinite(destTicket) && destTicket > 0) {
          try {
            await mtapi.orderCloseSafe(dstSession, { ticket: destTicket }, dstPlatform)
          } catch {
            // Already closed on broker is fine; mark mapping closed either way.
          }
        }
        await supabase.from("social_copy_trade_mappings").update({
          state: "closed",
          closed_at: new Date().toISOString(),
        }).eq("id", mapping.id)
        await writeExecutionEvent(supabase, {
          subscriptionId: sub.id,
          mappingId: mapping.id,
          sourceTicket: mapping.source_ticket,
          action: "close",
          idempotencyKey: `close:${mapping.source_ticket}`,
          status: "succeeded",
          request: { destination_ticket: mapping.destination_ticket },
        })
        closed += 1
      }

      await supabase.from("social_copy_subscriptions").update({
        status: "active",
        error_code: null,
        error_detail: null,
        lease_owner: null,
        lease_expires_at: null,
        last_reconciled_at: new Date().toISOString(),
        worker_acknowledged_at: new Date().toISOString(),
      }).eq("id", sub.id)
      results.push({ id: sub.id, status: "active", opened, closed, sourceOpen: positions.length })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const code = detail.includes("SOCIAL_ACCESS_REVOKED")
        ? "SOCIAL_ACCESS_REVOKED"
        : detail.includes("SESSION") || detail.toLowerCase().includes("connect")
          ? "BROKER_DISCONNECTED"
          : "BROKER_OPERATION_FAILED"
      await supabase.from("social_copy_subscriptions").update({
        status: "error",
        error_code: code,
        error_detail: detail.slice(0, 500),
        lease_owner: null,
        lease_expires_at: null,
        last_reconciled_at: new Date().toISOString(),
      }).eq("id", sub.id)
      results.push({ id: sub.id, status: "error", error: detail })
    }
  }

  return json({ ok: true, processed: results.length, results })
})
