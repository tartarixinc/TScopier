/**
 * Trigger MT4/MT5 broker-server catalog sync (edge: `sync-mt-servers`).
 * Pass `syncSecret` explicitly — do not ship the secret in Vite env for production builds.
 * Prefer cron/CI calling the edge function with `x-mt-sync-secret` or the service role key.
 */
export async function syncMtServersFromApi(opts: {
  syncSecret: string
  quick?: boolean
  terms?: string[]
}): Promise<{
  ok: boolean
  mt4Names: number
  mt5Names: number
  rowsPrepared: number
  upserted: number
  errorCount: number
}> {
  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/sync-mt-servers`
  const secret = opts.syncSecret.trim()
  if (!secret) {
    throw new Error("syncSecret is required")
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      "x-mt-sync-secret": secret,
    },
    body: JSON.stringify({
      quick: opts.quick === true,
      terms: opts.terms,
    }),
  })

  const text = await res.text()
  let body: Record<string, unknown> = {}
  if (text) {
    try { body = JSON.parse(text) as Record<string, unknown> } catch { /* */ }
  }
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : text || `HTTP ${res.status}`)
  }

  return {
    ok: Boolean(body.ok),
    mt4Names: Number(body.mt4Names ?? 0),
    mt5Names: Number(body.mt5Names ?? 0),
    rowsPrepared: Number(body.rowsPrepared ?? 0),
    upserted: Number(body.upserted ?? 0),
    errorCount: Number(body.errorCount ?? 0),
  }
}
