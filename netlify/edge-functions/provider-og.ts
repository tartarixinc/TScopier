/**
 * Open Graph / Twitter preview for public provider profiles (/p/{slug}).
 *
 * The app is a SPA, so link-preview crawlers (X, Telegram, WhatsApp, Slack)
 * would only ever see the generic index.html. This edge function reads the
 * public provider data through the anon-readable `get_provider_public_profile`
 * RPC and injects per-provider meta tags into the served HTML. If anything
 * fails it silently serves the untouched page.
 */
import type { Config, Context } from 'https://edge.netlify.com'

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function env(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const netlify = (globalThis as any).Netlify
  return netlify?.env?.get?.(name) ?? undefined
}

export default async function handler(request: Request, context: Context): Promise<Response> {
  const response = await context.next()
  try {
    const url = new URL(request.url)
    const slug = url.pathname.replace(/^\/p\//, '').replace(/\/+$/, '').toLowerCase()
    if (!SLUG.test(slug)) return response
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return response

    const supabaseUrl = env('VITE_SUPABASE_URL') ?? env('SUPABASE_URL')
    const anonKey = env('VITE_SUPABASE_ANON_KEY') ?? env('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !anonKey) return response

    const rpc = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/get_provider_public_profile`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_slug: slug }),
    })
    if (!rpc.ok) return response
    const rows = await rpc.json() as Array<{
      display_name: string
      bio: string | null
      account_kind: string | null
      platform: string | null
      monthly_copy_price_cents: number | null
    }>
    const provider = rows[0]
    if (!provider) return response

    const price = provider.monthly_copy_price_cents == null
      ? ''
      : provider.monthly_copy_price_cents === 0
        ? 'Free to copy'
        : `$${(provider.monthly_copy_price_cents / 100).toFixed(2)}/month`
    const facts = [provider.account_kind ? provider.account_kind.toUpperCase() : null, provider.platform, price]
      .filter(Boolean)
      .join(' · ')
    const title = `${provider.display_name} — Copy trading on TScopier`
    const description = (provider.bio?.trim() || `Follow and copy ${provider.display_name} on TScopier.`).slice(0, 200)
      + (facts ? ` (${facts})` : '')
    const canonical = `${url.origin}/p/${slug}`

    const tags = [
      `<meta property="og:type" content="profile">`,
      `<meta property="og:site_name" content="TScopier">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(description)}">`,
      `<meta property="og:url" content="${escapeHtml(canonical)}">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${escapeHtml(title)}">`,
      `<meta name="twitter:description" content="${escapeHtml(description)}">`,
      `<meta name="description" content="${escapeHtml(description)}">`,
      `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    ].join('\n    ')

    const html = (await response.text())
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
      .replace('</head>', `    ${tags}\n  </head>`)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.set('cache-control', 'public, max-age=0, must-revalidate')
    return new Response(html, { status: response.status, headers })
  } catch {
    return response
  }
}

export const config: Config = { path: '/p/*' }
