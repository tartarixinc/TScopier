/**
 * DXtrade server URL rules. Every broker hosts its own REST server, so the URL is user supplied
 * and must be treated as an SSRF surface. Mirrors `supabase/functions/_shared/dxtradeApi.ts`.
 */
import { promises as dns } from 'node:dns'

export const DXTRADE_API_PATH = '/dxsca-web'

const BLOCKED_HOST_SUFFIXES = [
  '.local', '.localhost', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet', '.private',
]

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase()
  if (isIpv4Literal(value)) {
    const [a, b] = value.split('.').map(Number) as [number, number]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
    if (mapped) return isPrivateIp(mapped[1]!)
    return false
  }
  return false
}

export type DxtradeUrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Accepts `https://host`, `https://host/` or `https://host/dxsca-web` and returns
 * `https://host/dxsca-web`. Rejects plain http, credentials, odd ports, IP literals, single-label
 * and internal-looking host names.
 */
export function normalizeDxtradeServerUrl(input: string): DxtradeUrlResult {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: "Enter your broker's DXtrade server URL" }
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'That server URL is not valid' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The DXtrade server URL must start with https://' }
  if (parsed.username || parsed.password) return { ok: false, error: 'Remove the username or password from the server URL' }
  if (parsed.port && parsed.port !== '443') return { ok: false, error: 'The DXtrade server URL must use the standard HTTPS port' }
  if (parsed.search || parsed.hash) return { ok: false, error: 'Remove the query string from the server URL' }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':') || isIpv4Literal(host) || host.startsWith('[')) {
    return { ok: false, error: "Use your broker's host name, not an IP address" }
  }
  if (!host.includes('.') || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return { ok: false, error: 'That server URL is not a public broker address' }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: 'That server URL is not valid' }
  }

  const path = parsed.pathname.replace(/\/+$/, '')
  if (path !== '' && path.toLowerCase() !== DXTRADE_API_PATH) {
    return { ok: false, error: 'The server URL should look like https://your-broker.com/dxsca-web' }
  }
  return { ok: true, url: `https://${host}${DXTRADE_API_PATH}` }
}

export type HostResolver = (host: string) => Promise<string[]>

export const resolveHostAddresses: HostResolver = async host => {
  const rows = await dns.lookup(host, { all: true })
  return rows.map(row => row.address)
}

/** Rejects hosts whose DNS answers point at private space. */
export async function assertPublicHost(serverUrl: string, resolve: HostResolver = resolveHostAddresses): Promise<void> {
  const host = new URL(serverUrl).hostname
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new Error("Could not find the broker's DXtrade server")
  }
  if (addresses.some(isPrivateIp)) {
    throw new Error('The DXtrade server URL resolves to a private address and cannot be used')
  }
}
