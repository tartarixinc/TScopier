import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { isMtApiAuthConfigured } from "../_shared/metatraderapi.ts"
import { collectMtServerRowsFromApi, MT_SERVER_SEARCH_TERMS } from "../_shared/mtServerSearch.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, x-mt-sync-secret",
}

const BATCH = 400

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function isAuthorized(req: Request): boolean {
  const secret = (Deno.env.get("MT_SERVERS_SYNC_SECRET") ?? "").trim()
  if (secret) {
    const hdr = req.headers.get("x-mt-sync-secret")?.trim()
    if (hdr && hdr === secret) return true
  }

  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  const auth = req.headers.get("Authorization")?.trim() ?? ""
  if (serviceKey && auth === `Bearer ${serviceKey}`) return true

  const apikey = req.headers.get("apikey")?.trim() ?? ""
  if (serviceKey && apikey === serviceKey) return true

  return false
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "POST" && req.method !== "GET") {
    return bad(405, "Use POST or GET")
  }
  if (!isAuthorized(req)) return bad(401, "Unauthorized")

  try {
    if (!isMtApiAuthConfigured(Deno.env)) {
      return bad(
        503,
        "MT API not configured. Set MT4API_BASIC_USER and MT4API_BASIC_PASSWORD in Edge secrets.",
      )
    }

    let terms: string[] | undefined
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({} as Record<string, unknown>))
      if (Array.isArray(body.terms)) {
        terms = body.terms
          .map((t) => String(t).trim())
          .filter((t) => t.length >= 4)
      }
      if (body.quick === true) {
        terms = ["exnes", "icmar", "ftmo", "deriv", "meta", "demo", "live", "peppe", "oanda"]
      }
    }

    const { stats, rows } = await collectMtServerRowsFromApi(Deno.env, { terms })

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    let upserted = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const { error } = await supabase
        .from("mt_servers")
        .upsert(chunk, { onConflict: "server_name_normalized" })
      if (error) {
        return bad(500, `mt_servers upsert failed: ${error.message}`)
      }
      upserted += chunk.length
    }

    return Response.json(
      {
        ok: true,
        searchTerms: stats.searchTerms,
        defaultTermCount: MT_SERVER_SEARCH_TERMS.length,
        mt4Names: stats.mt4Names,
        mt5Names: stats.mt5Names,
        rowsPrepared: rows.length,
        upserted,
        errors: stats.errors.slice(0, 50),
        errorCount: stats.errors.length,
      },
      { headers: corsHeaders },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return bad(500, msg)
  }
})
