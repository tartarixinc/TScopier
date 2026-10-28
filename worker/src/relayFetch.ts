/**
 * Option B gateway support (Railway env-breach containment).
 *
 * When SUPABASE_RELAY_TOKEN is set, every fetch to SUPABASE_URL (supabase-js
 * clients, custom function calls) gains an `x-relay-token` header, which the
 * VPS nginx relay (`supa-gw.tscopier.ai`) requires before proxying to
 * sso.tscopier.ai. Attackers holding the leaked service JWT cannot reach the
 * database because (a) Cloudflare blocks that JWT on the direct hostname and
 * (b) the gateway rejects requests without this post-breach secret.
 *
 * Call installRelayFetch() at the top of every worker ENTRYPOINT (before any
 * Supabase client is constructed): index.ts, whatsappListener.ts,
 * discordListener.ts, and standalone diagnostics that create their own client.
 */

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

export function installRelayFetch(): void {
  const token = String(process.env.SUPABASE_RELAY_TOKEN ?? '').trim()
  const base = String(process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  if (!token || !base) return

  const nativeFetch = globalThis.fetch.bind(globalThis)
  const isSupabaseUrl = (url: string): boolean => url === base || url.startsWith(`${base}/`)

  globalThis.fetch = ((input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url

    if (!isSupabaseUrl(url)) return nativeFetch(input as never, init as never)

    if (input instanceof Request && init == null) {
      const headers = new Headers(input.headers)
      if (!headers.has('x-relay-token')) headers.set('x-relay-token', token)
      return nativeFetch(new Request(input, { headers }) as never)
    }

    const headers = new Headers(init?.headers)
    if (!headers.has('x-relay-token')) headers.set('x-relay-token', token)
    return nativeFetch(input as never, { ...(init ?? {}), headers } as never)
  }) as typeof fetch
}
