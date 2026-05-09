import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_BASE_URL = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")
const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""

async function deleteProviderAccount(accountId: string) {
  const url = `${METATRADERAPI_BASE_URL}/DeleteAccount?id=${encodeURIComponent(accountId)}`
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": METATRADERAPI_KEY,
    },
  })
  const raw = await res.text()
  let json: unknown = null
  try { json = JSON.parse(raw) } catch { /* plain text response */ }
  return { ok: res.ok, status: res.status, raw, json }
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

    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }

    if (!METATRADERAPI_KEY) {
      return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
    }

    const body = await req.json().catch(() => ({})) as { broker_account_id?: string }
    const brokerAccountId = String(body.broker_account_id ?? "").trim()
    if (!brokerAccountId) {
      return Response.json({ error: "broker_account_id is required" }, { status: 400, headers: corsHeaders })
    }

    const { data: broker, error: brokerErr } = await supabase
      .from("broker_accounts")
      .select("id,user_id,metaapi_account_id,platform")
      .eq("id", brokerAccountId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (brokerErr) {
      return Response.json({ error: brokerErr.message }, { status: 500, headers: corsHeaders })
    }
    if (!broker) {
      return Response.json({ error: "Broker account not found" }, { status: 404, headers: corsHeaders })
    }

    const providerAccountId = String((broker as { metaapi_account_id?: string }).metaapi_account_id ?? "").trim()
    if (!providerAccountId) {
      return Response.json({ error: "Missing provider account id" }, { status: 400, headers: corsHeaders })
    }

    const providerRes = await deleteProviderAccount(providerAccountId)
    if (!providerRes.ok) {
      return Response.json(
        {
          error: "Failed to delete account in Metatraderapi",
          provider_status: providerRes.status,
          provider_response: providerRes.json ?? providerRes.raw,
        },
        { status: 502, headers: corsHeaders },
      )
    }

    const { error: deleteErr } = await supabase
      .from("broker_accounts")
      .delete()
      .eq("id", brokerAccountId)
      .eq("user_id", user.id)

    if (deleteErr) {
      return Response.json({ error: deleteErr.message }, { status: 500, headers: corsHeaders })
    }

    return Response.json(
      {
        ok: true,
        deleted_broker_account_id: brokerAccountId,
        deleted_provider_account_id: providerAccountId,
      },
      { headers: corsHeaders },
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("delete-metatrader-account error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
