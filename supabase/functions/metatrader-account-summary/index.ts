import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_BASE_URL = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")
const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""

type SummaryShape = {
  balance: number | null
  equity: number | null
  currency: string | null
  broker: string | null
  /** MT server hostname from provider payload or our DB; used when broker/company is missing. */
  mt_server_hint: string | null
  account_type: "Live" | "Demo" | null
  open_pnl: number | null
  open_trades: number | null
  source: string
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

const MT_SERVER_KEYS = new Set([
  "server",
  "Server",
  "brokerServer",
  "BrokerServer",
  "tradeServer",
  "TradeServer",
  "loginServer",
  "LoginServer",
])

/** Metatraderapi.dev often nests `server` away from top-level broker/company. */
function extractMtServerHint(payload: unknown, depth = 0): string | null {
  if (depth > 10 || payload == null) return null
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const o = payload as Record<string, unknown>
    for (const [k, v] of Object.entries(o)) {
      if (MT_SERVER_KEYS.has(k)) {
        const s = toStringOrNull(v)
        if (s) return s
      }
    }
    for (const v of Object.values(o)) {
      const nested = extractMtServerHint(v, depth + 1)
      if (nested) return nested
    }
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractMtServerHint(item, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function legacyServerFromMetaapiId(id: string): string | null {
  const t = id.trim()
  const i = t.indexOf("|")
  if (i <= 0) return null
  const left = t.slice(0, i).trim()
  return left || null
}

function parseSummary(payload: unknown, source: string): SummaryShape {
  const p = (payload && typeof payload === "object" ? payload as Record<string, unknown> : {}) as Record<string, unknown>
  const summary = (p.summary && typeof p.summary === "object" ? p.summary as Record<string, unknown> : {}) as Record<string, unknown>
  const broker =
    toStringOrNull(p.broker ?? p.Broker ?? p.company ?? p.Company ?? p.brokerName ?? p.server ?? p.Server) ??
    toStringOrNull(summary.broker ?? summary.Broker ?? summary.company ?? summary.Company ?? summary.server ?? summary.Server)

  const rawType = String(
    p.accountType ??
    p.AccountType ??
    p.type ??
    p.Type ??
    p.tradeMode ??
    p.TradeMode ??
    summary.accountType ??
    summary.AccountType ??
    summary.type ??
    summary.Type ??
    summary.tradeMode ??
    summary.TradeMode ??
    "",
  ).toLowerCase()
  const isDemoFlag =
    p.isDemo === true ||
    p.demo === true ||
    summary.isDemo === true ||
    summary.demo === true ||
    rawType.includes("demo")
  const accountType: "Live" | "Demo" | null =
    isDemoFlag ? "Demo" : (rawType ? "Live" : null)

  const mt_server_hint =
    extractMtServerHint(p) ??
    extractMtServerHint(summary) ??
    toStringOrNull(p.server ?? p.Server ?? summary.server ?? summary.Server)

  return {
    balance: toNumber(p.balance ?? p.Balance ?? summary.balance ?? summary.Balance),
    equity: toNumber(p.equity ?? p.Equity ?? summary.equity ?? summary.Equity),
    currency: toStringOrNull(p.currency ?? p.Currency ?? summary.currency ?? summary.Currency),
    broker,
    mt_server_hint,
    account_type: accountType,
    open_pnl: toNumber(
      p.openProfit ??
      p.OpenProfit ??
      p.floatingProfit ??
      p.FloatingProfit ??
      summary.openProfit ??
      summary.OpenProfit ??
      summary.floatingProfit ??
      summary.FloatingProfit,
    ),
    open_trades: toNumber(
      p.openTrades ??
      p.OpenTrades ??
      summary.openTrades ??
      summary.OpenTrades,
    ),
    source,
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
    const brokerAccountId = (body.broker_account_id ?? "").trim()
    if (!brokerAccountId) {
      return Response.json({ error: "broker_account_id is required" }, { status: 400, headers: corsHeaders })
    }

    const { data: brokerAccount, error: brokerErr } = await supabase
      .from("broker_accounts")
      .select("*")
      .eq("id", brokerAccountId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (brokerErr || !brokerAccount) {
      return Response.json({ error: "Broker account not found" }, { status: 404, headers: corsHeaders })
    }

    const accountId = encodeURIComponent(brokerAccount.metaapi_account_id)
    const from = encodeURIComponent("2024-01-01T00:00:00")
    const candidates = [
      { path: `/AccountSummary?id=${accountId}`, source: "AccountSummary" },
      { path: `/Account?id=${accountId}`, source: "Account" },
      { path: `/TradeStats?id=${accountId}&from=${from}`, source: "TradeStats" },
    ]

    const attempted: Array<{ source: string; status: number; detail?: unknown }> = []

    for (const c of candidates) {
      const res = await fetch(`${METATRADERAPI_BASE_URL}${c.path}`, {
        method: "GET",
        headers: {
          "x-api-key": METATRADERAPI_KEY,
        },
      })
      const raw = await res.text()
      let payload: unknown = null
      try { payload = JSON.parse(raw) } catch { payload = raw }
      attempted.push({ source: c.source, status: res.status, detail: res.ok ? undefined : payload })
      if (!res.ok) continue

      const parsed = parseSummary(payload, c.source)
      if (parsed.balance != null || parsed.equity != null) {
        const dbServer = toStringOrNull(
          (brokerAccount as Record<string, unknown>).broker_server as unknown,
        )
        const legacy = legacyServerFromMetaapiId(brokerAccount.metaapi_account_id ?? "")
        parsed.mt_server_hint =
          dbServer ??
          parsed.mt_server_hint ??
          legacy ??
          null

        // Some providers return balance/equity in AccountSummary but keep
        // open floating PnL only in TradeStats.summary.openProfit.
        if (parsed.open_pnl == null) {
          const statsRes = await fetch(
            `${METATRADERAPI_BASE_URL}/TradeStats?id=${accountId}&from=${from}`,
            {
              method: "GET",
              headers: {
                "x-api-key": METATRADERAPI_KEY,
              },
            },
          )
          if (statsRes.ok) {
            const statsRaw = await statsRes.text()
            let statsPayload: unknown = null
            try { statsPayload = JSON.parse(statsRaw) } catch { statsPayload = null }
            const statsParsed = parseSummary(statsPayload, "TradeStats")
            if (statsParsed.open_pnl != null) {
              parsed.open_pnl = statsParsed.open_pnl
            }
          }
        }
        return Response.json(
          {
            ok: true,
            summary: parsed,
            raw: payload,
          },
          { headers: corsHeaders },
        )
      }
    }

    return Response.json(
      {
        ok: false,
        error: "Balance/Equity not found in provider response",
        attempted,
      },
      { status: 400, headers: corsHeaders },
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("metatrader-account-summary error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
