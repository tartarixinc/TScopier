/**
 * clear-channel-active-params — delete channel_active_trade_params when a
 * channel+symbol basket is fully flat (no open trades or active pendings).
 *
 * Invoked by pg_net from the trades close trigger; worker also calls the same
 * logic synchronously on broker-driven closes.
 */

// @ts-ignore Deno runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
import { clearChannelActiveTradeParamsWhenFlat } from "../_shared/channelActiveTradeParamsClear.ts"

// @ts-ignore Deno globals
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

type ClearRequestBody = {
  user_id?: string
  channel_id?: string
  symbol?: string
}

Deno.serve(async (req: Request) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), { status: 500 })
  }

  const authHeader = req.headers.get("Authorization") ?? ""
  const token = authHeader.replace(/^Bearer\s+/i, "")
  if (token !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
  }

  let body: ClearRequestBody = {}
  try {
    body = await req.json() as ClearRequestBody
  } catch {
    return new Response(JSON.stringify({ error: "invalid json body" }), { status: 400 })
  }

  const userId = body.user_id?.trim()
  const channelId = body.channel_id?.trim()
  const symbol = body.symbol?.trim()
  if (!userId || !channelId || !symbol) {
    return new Response(
      JSON.stringify({ error: "user_id, channel_id, and symbol are required" }),
      { status: 400 },
    )
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const result = await clearChannelActiveTradeParamsWhenFlat(supabase, {
    userId,
    channelId,
    symbolHint: symbol,
  })

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
