import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const SEED_ID = 'tscopier-personal-social-v1'
const SHARED_PROJECT_REFS = new Set([
  'axdcledcyhyvzrnfkwat',
  'sxkpcovbyaficvtkpsdo',
  'supmsgcubipmmowrzoub',
])
const EXPECTED = {
  closedTradeCount: 10,
  realizedProfit: 470,
  winRate: 70,
  profitFactor: 5.9474,
  reviewRating: 5,
}

class AssertionFailure extends Error {
  constructor(message) {
    super(message)
    this.name = 'AssertionFailure'
  }
}

class OperationFailure extends Error {
  constructor(kind, operation, cause) {
    const detail = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)
    super(`${kind} error during ${operation}: ${detail}`)
    this.name = 'OperationFailure'
    this.kind = kind
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new OperationFailure('configuration', name, `Missing required environment variable ${name}`)
  return value
}

export function projectRefFromUrl(rawUrl) {
  // Match the literal configuration first. URL() normalizes some malformed
  // paths to '/', so parsing alone is not strict enough for this safety gate.
  const originMatch = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(rawUrl)
  if (!originMatch) {
    throw new OperationFailure('configuration', 'validate Supabase URL', 'Expected the exact HTTPS project origin with no credentials, port, path, query, or fragment')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw new OperationFailure('configuration', 'parse Supabase URL', error)
  }
  if (url.protocol !== 'https:') {
    throw new OperationFailure('configuration', 'validate Supabase URL', 'Expected an HTTPS Supabase project origin')
  }
  if (url.username || url.password) {
    throw new OperationFailure('configuration', 'validate Supabase URL', 'URL credentials are forbidden')
  }
  if (url.port) {
    throw new OperationFailure('configuration', 'validate Supabase URL', 'Non-default ports are forbidden')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new OperationFailure('configuration', 'validate Supabase URL', 'Expected the exact project origin with no path, query, or fragment')
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname)
  if (!match) throw new OperationFailure('configuration', 'validate Supabase URL', 'Expected https://project-ref.supabase.co')
  return match[1].toLowerCase()
}

function deterministicUuid(projectRef, name) {
  const hex = createHash('sha256').update(`${SEED_ID}:${projectRef}:${name}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function publicClient(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

function assert(condition, message) {
  if (!condition) throw new AssertionFailure(message)
}

function assertClose(actual, expected, label, tolerance = 0.0001) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label} is not a finite number`)
  assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual}`)
}

function redact(message, secrets) {
  let safe = message
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]')
  }
  return safe.replace(/(access_token|refresh_token|password|apikey)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
}

async function signIn(url, anonKey, email, password, role) {
  const client = publicClient(url, anonKey)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new OperationFailure('authentication', `sign in synthetic ${role}`, error)
  assert(data.user?.email?.toLowerCase() === email.toLowerCase(), `Synthetic ${role} authenticated as an unexpected user`)
  return { client, user: data.user }
}

async function rpc(client, name, args, operation) {
  const { data, error } = await client.rpc(name, args)
  if (error) throw new OperationFailure('RPC', operation, error)
  return data
}

function oneRow(data, label) {
  assert(Array.isArray(data), `${label} did not return an array`)
  assert(data.length === 1, `${label}: expected one row, received ${data.length}`)
  return data[0]
}

async function expectRpcDenied(client, name, args, expectedMessage) {
  const { data, error } = await client.rpc(name, args)
  assert(data == null || (Array.isArray(data) && data.length === 0), `${name} unexpectedly returned protected data`)
  assert(Boolean(error), `${name} unexpectedly succeeded for an unauthorized viewer`)
  assert(String(error.message).includes(expectedMessage), `${name} failed for an unexpected reason: ${error.message}`)
}

async function verifyDirectory(viewerClient, providerId, viewerId) {
  const rows = await rpc(viewerClient, 'get_social_directory', undefined, 'load Social Trading directory')
  assert(Array.isArray(rows), 'Directory RPC did not return an array')
  const syntheticProviders = rows.filter(row => row.is_synthetic_demo === true)
  assert(syntheticProviders.length === 8, 'Expected eight synthetic demo traders, received ' + syntheticProviders.length)
  assert(syntheticProviders.every(row => row.display_name.includes('Seed Provider')), 'A synthetic provider is not clearly labelled')
  const provider = rows.find(row => row.profile_user_id === providerId)
  const viewer = rows.find(row => row.profile_user_id === viewerId)
  assert(provider, 'Synthetic provider is missing from the Social Trading directory')
  assert(viewer, 'Synthetic viewer is missing from the Social Trading directory')
  assert(provider.display_name === 'Parker Seed Provider', 'Synthetic provider display name is incorrect')
  assert(provider.access_mode === 'open', 'Synthetic provider is not open')
  assert(provider.viewer_relationship_status === 'accepted', 'Viewer follow relationship is not accepted')
  assert(provider.shares_trade_history === true, 'Provider directory consent flag is not enabled')
  assert(Number(provider.follower_count) >= 1, 'Provider follower count does not include the synthetic viewer')
  assert(Number(provider.review_count) >= 1, 'Provider review count does not include the synthetic review')
  assertClose(Number(provider.viewer_rating), EXPECTED.reviewRating, 'Viewer rating', 0)
  assert(viewer.is_self === true, 'Viewer directory row is not marked as self')
}

async function verifyPerformance(viewerClient, providerId) {
  const access = oneRow(
    await rpc(viewerClient, 'get_social_trade_history_access', { p_trader_user_id: providerId }, 'check provider history access'),
    'Provider history access',
  )
  assert(access.sharing_enabled === true, 'Provider history sharing is disabled')
  assert(access.can_view === true, 'Viewer is not authorized to see provider history')

  const sources = await rpc(
    viewerClient,
    'get_social_copy_sources',
    { p_trader_user_id: providerId },
    'load provider copy sources',
  )
  assert(Array.isArray(sources) && sources.length === 1, 'Expected exactly one published source')
  const source = sources[0]
  assert(source.account_mode === 'demo', 'Published copy source is not demo')
  assert(source.connection_healthy === true, 'Published copy source is not healthy')
  assert(source.is_copy_eligible === false, 'Synthetic source unexpectedly appears copy eligible')
  assert(source.eligibility_reason === 'synthetic_demo', 'Synthetic source is missing its server-side copy block')

  const rows = await rpc(
    viewerClient,
    'get_social_provider_performance',
    { p_trader_user_id: providerId },
    'load provider performance',
  )
  const performance = rows.find(row => row.source_status === 'published')
  assert(performance, 'No published performance source was returned')
  assert(performance.source_id === source.source_id, 'Performance and copy-source RPCs returned different sources')
  assert(performance.performance_status === 'available', `Performance status is ${performance.performance_status}`)
  assert(performance.history_complete === true, 'Performance history is not complete')
  assert(performance.is_copy_eligible === true, `Provider is not eligible: ${performance.eligibility_reason}`)
  assert(performance.eligibility_reason === 'eligible', `Unexpected eligibility reason: ${performance.eligibility_reason}`)
  assert(performance.account_mode === 'demo', `Expected demo source, received ${performance.account_mode}`)
  assert(Number(performance.closed_trade_count) === EXPECTED.closedTradeCount, 'Closed-trade count is incorrect')
  assertClose(Number(performance.realized_profit), EXPECTED.realizedProfit, 'Realized P/L')
  assertClose(Number(performance.win_rate), EXPECTED.winRate, 'Win rate')
  assertClose(Number(performance.profit_factor), EXPECTED.profitFactor, 'Profit factor')
  assert(performance.return_percentage == null, 'Return percentage must remain unavailable')
  assert(performance.maximum_drawdown == null, 'Maximum drawdown must remain unavailable')
  assert(performance.equity_curve_available === false, 'Equity curve must remain unavailable')
  return performance.source_id
}

async function verifyTradeHistory(viewerClient, sourceId) {
  const rows = await rpc(
    viewerClient,
    'get_social_source_trade_history',
    { p_source_id: sourceId, p_limit: 100 },
    'load source-scoped trade history',
  )
  const closed = rows.filter(row => row.trade_status === 'closed')
  assert(closed.length === EXPECTED.closedTradeCount, `Expected 10 closed trades, received ${closed.length}`)
  assert(closed.every(row => row.trade_id && row.opened_at && row.closed_at && row.realized_profit != null), 'Closed history contains an incomplete trade')
  const realized = closed.reduce((sum, row) => sum + Number(row.realized_profit), 0)
  assertClose(realized, EXPECTED.realizedProfit, 'Trade-history realized P/L')
  const earliestOpen = Math.min(...closed.map(row => Date.parse(row.opened_at)))
  const latestClose = Math.max(...closed.map(row => Date.parse(row.closed_at)))
  assert(Number.isFinite(earliestOpen) && Number.isFinite(latestClose), 'Trade-history timestamps are invalid')
  assert(latestClose - earliestOpen >= 7 * 86_400_000, 'Closed-trade history spans less than seven days')
}

async function verifyDestinationAccount(viewerClient, viewerId, expectedBrokerId) {
  const { data, error } = await viewerClient.from('broker_accounts')
    .select('id,user_id,label,platform,provider,is_active,connection_status,linked_account_type,last_synced_at')
    .eq('user_id', viewerId)
    .eq('id', expectedBrokerId)
    .maybeSingle()
  if (error) throw new OperationFailure('query', 'load viewer broker account through browser RLS path', error)
  assert(data, 'Synthetic viewer destination broker account is missing through the browser data path')
  assert(data.is_active === true, 'Viewer destination account is inactive')
  assert(data.connection_status === 'connected', 'Viewer destination account is not connected')
  assert(String(data.linked_account_type).toLowerCase() === 'demo', 'Viewer destination account is not demo')
  assert(data.provider === 'fxsocket' && data.platform === 'MT5', 'Viewer destination account uses an unexpected provider/platform')
}

async function verifyReview(viewerClient, providerId) {
  const rows = await rpc(viewerClient, 'get_social_trader_reviews', { p_trader_user_id: providerId }, 'load provider reviews')
  const own = rows.find(row => row.is_own === true)
  assert(own, 'Synthetic viewer review is missing')
  assert(Number(own.rating) === EXPECTED.reviewRating, 'Synthetic review rating is incorrect')
  assert(String(own.review_text).includes('Synthetic personal-project review'), 'Synthetic review marker is missing')
}

async function main() {
  const url = requiredEnv('SOCIAL_PERSONAL_SUPABASE_URL')
  const configuredRef = requiredEnv('SOCIAL_PERSONAL_PROJECT_REF').toLowerCase()
  const anonKey = requiredEnv('SOCIAL_PERSONAL_ANON_KEY')
  const password = requiredEnv('SOCIAL_PERSONAL_TEST_PASSWORD')
  const urlRef = projectRefFromUrl(url)
  if (urlRef !== configuredRef) throw new OperationFailure('configuration', 'project safety check', 'URL and project reference do not match')
  if (SHARED_PROJECT_REFS.has(configuredRef)) throw new OperationFailure('configuration', 'project safety check', 'Known shared projects are forbidden')

  const providerEmail = `provider@${configuredRef}.tscopier-seed.example.com`
  const viewerEmail = `viewer@${configuredRef}.tscopier-seed.example.com`
  const expectedViewerBrokerId = deterministicUuid(configuredRef, 'viewer-broker')

  const { client: providerClient, user: provider } = await signIn(url, anonKey, providerEmail, password, 'provider')
  const { client: viewerClient, user: viewer } = await signIn(url, anonKey, viewerEmail, password, 'viewer')

  await verifyDirectory(viewerClient, provider.id, viewer.id)
  const sourceId = await verifyPerformance(viewerClient, provider.id)
  await verifyTradeHistory(viewerClient, sourceId)
  await verifyDestinationAccount(viewerClient, viewer.id, expectedViewerBrokerId)
  await verifyReview(viewerClient, provider.id)

  const privateAccess = oneRow(
    await rpc(providerClient, 'get_social_trade_history_access', { p_trader_user_id: viewer.id }, 'check denied viewer-history access'),
    'Viewer history access',
  )
  assert(privateAccess.sharing_enabled === false, 'Viewer history sharing should remain disabled')
  assert(privateAccess.can_view === false, 'Provider unexpectedly has access to viewer history')
  await expectRpcDenied(
    providerClient,
    'get_social_provider_performance',
    { p_trader_user_id: viewer.id },
    'Trader has not shared trade history with this viewer',
  )

  console.log(`Read-only Social Trading verification passed for personal project ${configuredRef}.`)
  console.log('Eight synthetic traders, copy safeguards, directory, follow, review, consent, RLS denial, provider performance, trade history, and viewer demo destination checks passed.')
  console.log('Return, maximum drawdown, and equity curve correctly remain unavailable.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const kind = error instanceof AssertionFailure
      ? 'ASSERTION FAILED'
      : error instanceof OperationFailure
        ? `${error.kind.toUpperCase()} FAILED`
        : 'VERIFICATION FAILED'
    const message = error instanceof Error ? error.message : String(error)
    console.error(`${kind}: ${redact(message, [
      process.env.SOCIAL_PERSONAL_ANON_KEY,
      process.env.SOCIAL_PERSONAL_TEST_PASSWORD,
    ])}`)
    process.exitCode = 1
  })
}
