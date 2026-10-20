/**
 * Match-Trader platform URL rules. Match-Trader is white-label: every broker hosts its own platform
 * URL, so it is user supplied and must be treated as an SSRF surface. Mirrors
 * `supabase/functions/_shared/matchtraderApi.ts`.
 */
import { promises as dns } from 'node:dns'
import { isPrivateIp } from '../dxtrade/serverUrl'

const BLOCKED_HOST_SUFFIXES = [
  '.local', '.localhost', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet', '.private',
]

export type MatchtraderUrlResult = { ok: true; url: string } | { ok: false; error: string }

/** Accepts `https://host` (a trailing slash is fine) and returns `https://host`. */
export function normalizeMatchtraderUrl(input: string): MatchtraderUrlResult {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: "Enter your broker's Match-Trader platform URL" }
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'That platform URL is not valid' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The platform URL must start with https://' }
  if (parsed.username || parsed.password) return { ok: false, error: 'Remove the username or password from the platform URL' }
  if (parsed.port && parsed.port !== '443') return { ok: false, error: 'The platform URL must use the standard HTTPS port' }
  if (parsed.search || parsed.hash) return { ok: false, error: 'Remove the query string from the platform URL' }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return { ok: false, error: "Use your broker's host name, not an IP address" }
  }
  if (!host.includes('.') || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return { ok: false, error: 'That platform URL is not a public broker address' }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: 'That platform URL is not valid' }
  }
  return { ok: true, url: `https://${host}` }
}

export type HostResolver = (host: string) => Promise<string[]>

export const resolveHostAddresses: HostResolver = async host => {
  const rows = await dns.lookup(host, { all: true })
  return rows.map(row => row.address)
}

/** Rejects hosts whose DNS answers point at private space. */
export async function assertPublicMatchtraderHost(serverUrl: string, resolve: HostResolver = resolveHostAddresses): Promise<void> {
  const host = new URL(serverUrl).hostname
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new Error("Could not find the broker's Match-Trader server")
  }
  if (addresses.some(isPrivateIp)) {
    throw new Error('The Match-Trader platform URL resolves to a private address and cannot be used')
  }
}
