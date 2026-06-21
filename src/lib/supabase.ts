import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { RealtimeClient } from '@supabase/realtime-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''

if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && 'VITE_SUPABASE_URL',
    !supabaseAnonKey && 'VITE_SUPABASE_ANON_KEY',
  ].filter(Boolean).join(', ')
  throw new Error(
    `Missing ${missing}. For Netlify, set these under Site configuration → Environment variables ` +
      `(names must start with VITE_), scope must include Builds, then trigger a new deploy.`,
  )
}

function normalizeRealtimeEndpoint(raw: string): string {
  const trimmed = raw.replace(/\/$/, '')
  const withProtocol = trimmed.startsWith('ws')
    ? trimmed
    : trimmed.replace(/^http/i, match => (match.toLowerCase() === 'https' ? 'wss' : 'ws'))
  return withProtocol.endsWith('/realtime/v1') ? withProtocol : `${withProtocol}/realtime/v1`
}

function applyOptionalRealtimeEndpoint(client: SupabaseClient, anonKey: string): void {
  const override = import.meta.env.VITE_SUPABASE_REALTIME_URL?.trim()
  if (!override) return

  const endpoint = normalizeRealtimeEndpoint(override)
  const current = client.realtime.endPoint.replace(/\/websocket$/, '')
  if (current === endpoint || `${current}/websocket` === `${endpoint}/websocket`) return

  const existing = client.realtime as RealtimeClient & {
    accessToken?: () => Promise<string | null | undefined>
    headers?: Record<string, string>
    fetch?: typeof fetch
  }

  ;(client as { realtime: RealtimeClient }).realtime = new RealtimeClient(endpoint, {
    params: { apikey: anonKey },
    accessToken: existing.accessToken?.bind(existing),
    headers: existing.headers,
    fetch: existing.fetch,
    disconnectOnEmptyChannelsAfterMs: 60_000,
  })
}

// Using untyped client to avoid complex generic resolution issues.
// Row types are imported from types/database and cast at call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    disconnectOnEmptyChannelsAfterMs: 60_000,
  },
})

applyOptionalRealtimeEndpoint(supabase, supabaseAnonKey)
