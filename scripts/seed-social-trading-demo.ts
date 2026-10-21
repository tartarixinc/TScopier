import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

export const PREVIEW_PROJECT_REF = 'supmsgcubipmmowrzoub'
export const BLOCKED_PROJECT_REFS = ['sxkpcovbyaficvtkpsdo', 'axdcledcyhyvzrnfkwat'] as const
export const CLOSED_TRADES_PER_TRADER = 12
export const OPEN_TRADES_PER_TRADER = 1

export type DemoTrader = {
  userId: string
  brokerAccountId: string
  sourceId: string
  email: string
  displayName: string
  username: string
  country: string
  accessMode: 'open' | 'private'
  instruments: readonly string[]
  profits: readonly number[]
}

const identity = (index: number, values: Omit<DemoTrader, 'userId' | 'brokerAccountId' | 'sourceId' | 'email'>): DemoTrader => ({
  ...values,
  userId: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  brokerAccountId: `d1000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  sourceId: `d2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  email: `social-demo-${index}@tscopier.invalid`,
})

export const DEMO_TRADERS: readonly DemoTrader[] = [
  identity(1, { displayName: 'Amira Hassan [DEMO]', username: 'demo_amira', country: 'United Arab Emirates', accessMode: 'open', instruments: ['XAUUSD', 'EURUSD', 'US30'], profits: [185, -42, 96, 0, 214, -68, 121, 74, -35, 162, 88, -54] }),
  identity(2, { displayName: 'Leo Berg [DEMO]', username: 'demo_leoberg', country: 'Sweden', accessMode: 'private', instruments: ['USDJPY', 'EURUSD', 'GBPJPY'], profits: [64, -91, 48, 37, -52, 83, 0, -28, 119, 42, -67, 55] }),
  identity(3, { displayName: 'Nora Okonkwo [DEMO]', username: 'demo_nora', country: 'Nigeria', accessMode: 'open', instruments: ['NAS100', 'XAUUSD', 'GBPUSD'], profits: [228, 94, -61, 135, 72, -44, 0, 181, -39, 117, 86, -58] }),
  identity(4, { displayName: 'Kenji Sato [DEMO]', username: 'demo_kenji', country: 'Japan', accessMode: 'open', instruments: ['USDJPY', 'EURJPY', 'XAUUSD'], profits: [51, 33, -47, 62, -29, 75, 44, 0, -36, 91, 28, -22] }),
  identity(5, { displayName: 'Sofia Alvarez [DEMO]', username: 'demo_sofia', country: 'Spain', accessMode: 'private', instruments: ['EURUSD', 'GBPUSD', 'GER40'], profits: [103, -55, 89, 41, -73, 126, 58, -31, 0, 94, 67, -46] }),
  identity(6, { displayName: 'Mateo Silva [DEMO]', username: 'demo_mateo', country: 'Brazil', accessMode: 'open', instruments: ['US30', 'NAS100', 'USDJPY'], profits: [142, 77, -84, 96, -38, 154, 69, -57, 111, 0, 88, -63] }),
  identity(7, { displayName: 'Aisha Bello [DEMO]', username: 'demo_aisha', country: 'Nigeria', accessMode: 'open', instruments: ['XAUUSD', 'GBPJPY', 'EURUSD'], profits: [176, -49, 118, 82, -71, 139, 0, 65, -43, 151, 92, -56] }),
  identity(8, { displayName: 'Daniel Kim [DEMO]', username: 'demo_daniel', country: 'South Korea', accessMode: 'private', instruments: ['NAS100', 'USDJPY', 'XAUUSD'], profits: [87, -34, 73, 46, -59, 101, 38, -27, 79, 0, 66, -41] }),
] as const

export function assertPreviewConfiguration(urlValue: string | undefined, serviceRoleKey: string | undefined): URL {
  if (!urlValue) throw new Error('SUPABASE_URL is required')
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  const url = new URL(urlValue)
  const ref = url.hostname.split('.')[0]
  if (BLOCKED_PROJECT_REFS.includes(ref as typeof BLOCKED_PROJECT_REFS[number])) {
    throw new Error(`Refusing blocked Supabase project ${ref}`)
  }
  if (url.protocol !== 'https:' || url.hostname !== `${PREVIEW_PROJECT_REF}.supabase.co`) {
    throw new Error(`Refusing non-preview Supabase target ${url.hostname}`)
  }
  return url
}

export function buildDemoBrokerAccounts(anchor = new Date()): Array<Record<string, unknown>> {
  return DEMO_TRADERS.map(trader => ({
    id: trader.brokerAccountId,
    user_id: trader.userId,
    label: `${trader.displayName} synthetic MT5`,
    platform: 'MT5',
    provider: 'fxsocket',
    metaapi_account_id: '',
    is_active: true,
    connection_status: 'connected',
    linked_account_type: 'Demo',
    last_currency: 'USD',
    last_synced_at: anchor.toISOString(),
  }))
}

export function buildDemoTrades(trader: DemoTrader, anchor = new Date()): Array<Record<string, unknown>> {
  const rows = trader.profits.map((profit, index) => {
    const closedAt = new Date(anchor.getTime() - (CLOSED_TRADES_PER_TRADER - index) * 24 * 60 * 60 * 1000)
    const openedAt = new Date(closedAt.getTime() - (3 + index % 7) * 60 * 60 * 1000)
    const sequence = index + 1
    return {
      id: `d3${String(DEMO_TRADERS.indexOf(trader) + 1).padStart(6, '0')}-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      user_id: trader.userId,
      broker_account_id: trader.brokerAccountId,
      metaapi_order_id: `synthetic-demo-${trader.username}-${sequence}`,
      symbol: trader.instruments[index % trader.instruments.length],
      direction: index % 3 === 0 ? 'sell' : 'buy',
      entry_price: 1 + index / 100,
      lot_size: 0.1 + (index % 3) * 0.05,
      status: 'closed',
      opened_at: openedAt.toISOString(),
      closed_at: closedAt.toISOString(),
      profit,
      created_at: openedAt.toISOString(),
    }
  })
  rows.push({
    id: `d3${String(DEMO_TRADERS.indexOf(trader) + 1).padStart(6, '0')}-0000-4000-8000-999999999999`,
    user_id: trader.userId,
    broker_account_id: trader.brokerAccountId,
    metaapi_order_id: `synthetic-demo-${trader.username}-open`,
    symbol: trader.instruments[0],
    direction: 'buy',
    entry_price: 1.25,
    lot_size: 0.1,
    status: 'open',
    opened_at: new Date(anchor.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    closed_at: null,
    profit: null,
    created_at: new Date(anchor.getTime() - 2 * 60 * 60 * 1000).toISOString(),
  })
  return rows
}

export function summarizeDemoTrades(rows: Array<Record<string, unknown>>) {
  const closed = rows.filter(row => row.status === 'closed' && typeof row.profit === 'number')
  const profits = closed.map(row => Number(row.profit))
  const grossProfit = profits.reduce((sum, value) => sum + Math.max(0, value), 0)
  const grossLoss = Math.abs(profits.reduce((sum, value) => sum + Math.min(0, value), 0))
  return {
    closedTradeCount: closed.length,
    realizedProfit: profits.reduce((sum, value) => sum + value, 0),
    winRate: closed.length ? profits.filter(value => value > 0).length / closed.length * 100 : null,
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
  }
}

async function requireNoError<T extends { error: unknown }>(promise: PromiseLike<T>, context: string): Promise<T> {
  const result = await promise
  if (result.error) throw new Error(`${context} failed`, { cause: result.error })
  return result
}

async function ensureAuthUsers(client: SupabaseClient): Promise<Map<string, User>> {
  const listed = await client.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listed.error) throw new Error('Preview Auth identity check failed', { cause: listed.error })
  const byEmail = new Map(listed.data.users.map(user => [user.email ?? '', user]))
  const result = new Map<string, User>()
  for (const trader of DEMO_TRADERS) {
    let user = byEmail.get(trader.email)
    if (!user) {
      const created = await client.auth.admin.createUser({
        id: trader.userId,
        email: trader.email,
        password: `${randomUUID()}Aa1!`,
        email_confirm: true,
        user_metadata: { synthetic_demo: true, display_name: trader.displayName },
        app_metadata: { synthetic_demo: true },
      })
      if (created.error || !created.data.user) throw new Error(`Creating ${trader.username} failed`, { cause: created.error })
      user = created.data.user
    }
    if (user.id !== trader.userId) throw new Error(`Stable identity mismatch for ${trader.email}`)
    result.set(trader.userId, user)
  }
  return result
}

export async function seedSocialTradingDemo(client: SupabaseClient, anchor = new Date()) {
  const markerCheck = await client.from('social_copy_sources').select('id,is_synthetic').limit(1)
  if (markerCheck.error) throw new Error('Synthetic-source migration is not available; aborting before writes', { cause: markerCheck.error })
  const guardCheck = await client.rpc('social_source_performance_eligibility', { p_source_id: randomUUID() })
  const guardRow = Array.isArray(guardCheck.data) ? guardCheck.data[0] : null
  if (guardCheck.error || guardRow?.eligible !== false || guardRow?.reason !== 'source_missing') {
    throw new Error('Synthetic copy guard prerequisite could not be verified; aborting before writes', { cause: guardCheck.error })
  }

  await ensureAuthUsers(client)

  for (const trader of DEMO_TRADERS) {
    const profile = await client.from('user_profiles').select('user_id').eq('user_id', trader.userId).maybeSingle()
    if (profile.error || !profile.data) throw new Error(`Auth profile trigger did not create ${trader.username}`, { cause: profile.error })
    await requireNoError(client.from('user_profiles').update({
      display_name: trader.displayName,
      username: trader.username,
      country: trader.country,
      email_verified_at: anchor.toISOString(),
    }).eq('user_id', trader.userId), `Updating profile ${trader.username}`)
  }

  await requireNoError(client.from('social_profiles').upsert(DEMO_TRADERS.map(trader => ({
    user_id: trader.userId,
    access_mode: trader.accessMode,
    is_listed: true,
    share_trade_history: true,
  })), { onConflict: 'user_id' }), 'Upserting social profiles')

  await requireNoError(client.from('broker_accounts').upsert(buildDemoBrokerAccounts(anchor), { onConflict: 'id' }), 'Upserting synthetic broker accounts')

  await requireNoError(client.from('social_copy_sources').upsert(DEMO_TRADERS.map(trader => ({
    id: trader.sourceId,
    trader_user_id: trader.userId,
    broker_account_id: trader.brokerAccountId,
    status: 'published',
    label: `${trader.displayName} - SYNTHETIC DEMO`,
    is_synthetic: true,
  })), { onConflict: 'id' }), 'Upserting synthetic social sources')

  const tradeRows = DEMO_TRADERS.flatMap(trader => buildDemoTrades(trader, anchor))
  await requireNoError(client.from('trades').upsert(tradeRows, { onConflict: 'id' }), 'Upserting synthetic trades')

  const relationships = DEMO_TRADERS.flatMap((trader, index) => [1, 2].map(offset => ({
    follower_user_id: trader.userId,
    followed_user_id: DEMO_TRADERS[(index + offset) % DEMO_TRADERS.length].userId,
    status: 'accepted',
    responded_at: anchor.toISOString(),
  })))
  await requireNoError(client.from('social_follow_relationships').upsert(relationships, { onConflict: 'follower_user_id,followed_user_id' }), 'Upserting demo follows')

  const reviews = DEMO_TRADERS.map((trader, index) => ({
    reviewer_user_id: trader.userId,
    trader_user_id: DEMO_TRADERS[(index + 1) % DEMO_TRADERS.length].userId,
    rating: [5, 4, 5, 4, 3, 5, 4, 5][index],
    review_text: `Synthetic demo review by ${trader.displayName}.`,
  }))
  await requireNoError(client.from('social_trader_reviews').upsert(reviews, { onConflict: 'reviewer_user_id,trader_user_id' }), 'Upserting demo reviews')

  const verification = await requireNoError(client.from('trades').select('id,user_id,status,profit').in('user_id', DEMO_TRADERS.map(item => item.userId)), 'Verifying demo trades')
  if ((verification.data?.length ?? 0) !== tradeRows.length) throw new Error(`Expected ${tradeRows.length} demo trades, found ${verification.data?.length ?? 0}`)
  for (const trader of DEMO_TRADERS) {
    const eligibility = await client.rpc('social_source_performance_eligibility', { p_source_id: trader.sourceId })
    const row = Array.isArray(eligibility.data) ? eligibility.data[0] : null
    if (eligibility.error || row?.eligible !== false || row?.reason !== 'synthetic_demo') {
      throw new Error(`Synthetic copy guard verification failed for ${trader.username}`, { cause: eligibility.error })
    }
  }
  return { users: DEMO_TRADERS.length, trades: tradeRows.length, summaries: DEMO_TRADERS.map(trader => ({ username: trader.username, ...summarizeDemoTrades((verification.data ?? []).filter(row => row.user_id === trader.userId) as Array<Record<string, unknown>>)})) }
}

export async function main() {
  const url = assertPreviewConfiguration(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const client = createClient(url.toString(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
  const authCheck = await client.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (authCheck.error) throw new Error(`Could not positively verify Migration preview ${PREVIEW_PROJECT_REF}`, { cause: authCheck.error })
  const result = await seedSocialTradingDemo(client)
  console.log(`Seeded and verified ${result.users} synthetic DEMO users and ${result.trades} trade rows in ${PREVIEW_PROJECT_REF}.`)
  for (const summary of result.summaries) console.log(summary)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
