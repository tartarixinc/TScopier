import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_BASE_URL = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")
const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""

type JsonRecord = Record<string, unknown>

function pickAccountId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as JsonRecord
  const candidates = [
    p.id,
    p.accountId,
    p.account_id,
    p.uuid,
    p.accountUUID,
    p.accountUuid,
    (p.data as JsonRecord | undefined)?.id,
    (p.data as JsonRecord | undefined)?.accountId,
    (p.result as JsonRecord | undefined)?.id,
    (p.result as JsonRecord | undefined)?.accountId,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim()
  }
  return null
}

async function metaRequest(path: string, payload: JsonRecord) {
  const res = await fetch(`${METATRADERAPI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": METATRADERAPI_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  let json: unknown = null
  try { json = JSON.parse(raw) } catch { /* response may be plain text */ }
  return { ok: res.ok, status: res.status, raw, json }
}

async function registerAccountViaQuery(params: URLSearchParams) {
  const res = await fetch(`${METATRADERAPI_BASE_URL}/RegisterAccount?${params.toString()}`, {
    method: "GET",
    headers: {
      "x-api-key": METATRADERAPI_KEY,
    },
  })
  const raw = await res.text()
  let json: unknown = null
  try { json = JSON.parse(raw) } catch { /* response may be plain text */ }
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

    const body = await req.json().catch(() => ({})) as {
      label?: string
      platform?: string
      account_number?: string
      account_password?: string
      server?: string
      default_lot_size?: number
      pip_tolerance?: number
    }

    const platform = (body.platform ?? "").trim().toUpperCase()
    const accountNumber = (body.account_number ?? "").trim()
    const accountPassword = (body.account_password ?? "").trim()
    const server = (body.server ?? "").trim()
    const label = (body.label ?? "").trim()

    if (platform !== "MT4" && platform !== "MT5") {
      return Response.json({ error: "Only MT4/MT5 are supported by this flow" }, { status: 400, headers: corsHeaders })
    }
    if (!accountNumber || !accountPassword || !server) {
      return Response.json({ error: "account_number, account_password and server are required" }, { status: 400, headers: corsHeaders })
    }

    // Metatraderapi.dev docs mention /RegisterAccount but do not expose a strict payload schema.
    // We try common field variations for compatibility.
    const displayName = label || `${platform} - ${accountNumber}`
    const mtType = platform === "MT5" ? "Metatrader 5" : "Metatrader 4"

    const queryParams = new URLSearchParams({
      type: mtType,
      server,
      user: accountNumber,
      password: accountPassword,
      name: displayName,
    })

    const queryRes = await registerAccountViaQuery(queryParams)
    if (queryRes.ok) {
      const connectedAccountId = pickAccountId(queryRes.json) ?? pickAccountId({ id: queryRes.raw }) ?? null
      if (!connectedAccountId) {
        return Response.json(
          { error: "Account connected but no account id returned by Metatraderapi.dev", detail: queryRes.raw },
          { status: 502, headers: corsHeaders },
        )
      }

      const defaultLot = Number(body.default_lot_size ?? 0.01) || 0.01
      const pipTolerance = Number(body.pip_tolerance ?? 20) || 20

      const { data, error: insertErr } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: user.id,
          label: displayName,
          platform,
          metaapi_account_id: connectedAccountId,
          broker_server: server,
          default_lot_size: defaultLot,
          pip_tolerance: pipTolerance,
          is_active: true,
          max_trades_per_zone: 1,
        })
        .select("*")
        .single()

      if (insertErr) {
        return Response.json({ error: insertErr.message }, { status: 500, headers: corsHeaders })
      }

      await supabase
        .from("mt_servers")
        .upsert(
          {
            server_name: server,
            platform,
            source: "learned_runtime",
            is_active: true,
          },
          { onConflict: "server_name_normalized", ignoreDuplicates: false },
        )

      return Response.json(
        {
          ok: true,
          broker_account: data,
        },
        { headers: corsHeaders },
      )
    }

    // Metatraderapi.dev docs are inconsistent in some places. Keep POST
    // fallbacks for compatibility with any future schema changes.
    const endpointCandidates = ["/RegisterAccount", "/register-account"]
    const payloadCandidates: JsonRecord[] = [
      { type: platform, server, user: accountNumber, password: accountPassword, name: displayName },
      { platform, accountNumber, password: accountPassword, server },
      { platform, login: accountNumber, password: accountPassword, server },
      { platform, account: accountNumber, password: accountPassword, server },
      { type: platform, accountNumber, password: accountPassword, server },
      { type: platform, login: accountNumber, password: accountPassword, server },
    ]

    let connectedAccountId: string | null = null
    const attempts: Array<{ endpoint: string; status: number; body: string }> = [
      { endpoint: `/RegisterAccount?${queryParams.toString()}`, status: queryRes.status, body: queryRes.raw.slice(0, 800) },
    ]

    outer:
    for (const endpoint of endpointCandidates) {
      for (const payload of payloadCandidates) {
        const res = await metaRequest(endpoint, payload)
        attempts.push({ endpoint, status: res.status, body: res.raw.slice(0, 800) })
        if (!res.ok) continue
        connectedAccountId = pickAccountId(res.json) ?? pickAccountId({ id: res.raw }) ?? null
        if (connectedAccountId) break outer
      }
    }

    if (!connectedAccountId) {
      return Response.json(
        {
          error: "Could not connect account via Metatraderapi.dev RegisterAccount. Check account credentials/server.",
          attempts,
        },
        { status: 400, headers: corsHeaders },
      )
    }

    const defaultLot = Number(body.default_lot_size ?? 0.01) || 0.01
    const pipTolerance = Number(body.pip_tolerance ?? 20) || 20

    const { data, error: insertErr } = await supabase
      .from("broker_accounts")
      .insert({
        user_id: user.id,
        label: displayName,
        platform,
        metaapi_account_id: connectedAccountId,
        broker_server: server,
        default_lot_size: defaultLot,
        pip_tolerance: pipTolerance,
        is_active: true,
        max_trades_per_zone: 1,
      })
      .select("*")
      .single()

    if (insertErr) {
      return Response.json({ error: insertErr.message }, { status: 500, headers: corsHeaders })
    }

    await supabase
      .from("mt_servers")
      .upsert(
        {
          server_name: server,
          platform,
          source: "learned_runtime",
          is_active: true,
        },
        { onConflict: "server_name_normalized", ignoreDuplicates: false },
      )

    return Response.json(
      {
        ok: true,
        broker_account: data,
      },
      { headers: corsHeaders },
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("connect-metatrader-account error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
