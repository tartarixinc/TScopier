import { createHash } from 'node:crypto'
import { stdin, stdout } from 'node:process'
import readline from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const SEED_ID = 'tscopier-personal-social-v1'
const SHARED_PROJECT_REFS = new Set([
  'axdcledcyhyvzrnfkwat',
  'sxkpcovbyaficvtkpsdo',
  'supmsgcubipmmowrzoub',
])
const EXPECTED_PROFIT = 470
const TRADE_PROFITS = [120, -45, 85, 60, -30, 110, 40, -20, 95, 55]
const SOURCE_LABEL = `[${SEED_ID}] Verified Demo Source`

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

export function projectRefFromUrl(rawUrl) {
  // Do not normalize the configured value before checking it. URL() normalizes
  // dot segments, duplicate slashes, and default ports, which would otherwise
  // allow a value that was not the exact project origin supplied by the user.
  const originMatch = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(rawUrl)
  if (!originMatch) {
    throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must be the exact HTTPS project origin with no credentials, port, path, query, or fragment')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must be a valid HTTPS URL')
  }
  if (url.protocol !== 'https:') throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must use HTTPS')
  if (url.username || url.password) throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must not contain credentials')
  if (url.port) throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must not use a non-default port')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must be the exact project origin with no path, query, or fragment')
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname)
  if (!match) {
    throw new Error('SOCIAL_PERSONAL_SUPABASE_URL must use the project-ref.supabase.co hostname')
  }
  return match[1].toLowerCase()
}

function deterministicUuid(projectRef, name) {
  const hex = createHash('sha256').update(`${SEED_ID}:${projectRef}:${name}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function clientOptions() {
  return {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-tscopier-seed': SEED_ID } },
  }
}

function errorMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]')
  }
  return message.replace(/(access_token|refresh_token|password|apikey)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
}

function throwIfError(error, operation) {
  if (error) throw new Error(`${operation}: ${error.message}`)
}

async function confirmProject(projectRef) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Interactive terminal required; refusing to seed without typed project confirmation')
  }
  const prompt = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = await prompt.question(
      `This will mutate only personal Supabase project ${projectRef}. Type the exact project reference to continue: `,
    )
    if (answer.trim() !== projectRef) throw new Error('Project confirmation did not match; no remote requests were made')
  } finally {
    prompt.close()
  }
}

async function findAuthUserByEmail(admin, email) {
  const matches = []
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    throwIfError(error, 'list Auth users')
    const users = data?.users ?? []
    matches.push(...users.filter(user => user.email?.toLowerCase() === email.toLowerCase()))
    if (users.length < 200) break
  }
  if (matches.length > 1) throw new Error(`Multiple Auth users unexpectedly use synthetic email ${email}`)
  return matches[0] ?? null
}

function expectedMetadata(projectRef, role) {
  return {
    tscopier_seed_id: SEED_ID,
    tscopier_seed_project_ref: projectRef,
    tscopier_seed_role: role,
  }
}

function metadataHasExpectedMarkers(metadata, expected) {
  return Object.entries(expected).every(([key, value]) => metadata?.[key] === value)
}

export function assertOwnedAuthUser(user, projectRef, role, email) {
  const expected = expectedMetadata(projectRef, role)
  if (!metadataHasExpectedMarkers(user.app_metadata, expected) || !metadataHasExpectedMarkers(user.user_metadata, expected)) {
    throw new Error(`Synthetic email ${email} already exists without the expected seed ownership metadata`)
  }
}

async function ensureAuthUser(admin, { existingUser, email, password, projectRef, role, displayName }) {
  const metadata = expectedMetadata(projectRef, role)
  let user = existingUser
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { ...metadata, display_name: displayName },
      app_metadata: metadata,
    })
    throwIfError(error, `create ${role} Auth user`)
    if (!data.user) throw new Error(`create ${role} Auth user returned no user`)
    user = data.user
  } else {
    assertOwnedAuthUser(user, projectRef, role, email)
    const { data, error } = await admin.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
      user_metadata: { ...(user.user_metadata ?? {}), ...metadata, display_name: displayName },
      app_metadata: { ...(user.app_metadata ?? {}), ...metadata },
    })
    throwIfError(error, `refresh ${role} Auth user credentials`)
    if (!data.user) throw new Error(`refresh ${role} Auth user returned no user`)
    user = data.user
  }
  return user
}

async function waitForProfile(admin, userId, role) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await admin.from('user_profiles').select('user_id').eq('user_id', userId).maybeSingle()
    throwIfError(error, `check ${role} user profile trigger`)
    if (data) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for the ${role} user profile creation trigger`)
}

async function signIn(url, anonKey, email, password, role) {
  const client = createClient(url, anonKey, clientOptions())
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  throwIfError(error, `sign in synthetic ${role}`)
  if (!data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) {
    throw new Error(`Synthetic ${role} sign-in returned an unexpected identity`)
  }
  return client
}

async function configureActor(client, { userId, role, displayName, firstName, lastName, username, country, city, shareHistory }) {
  let result = await client.rpc('mark_email_verified')
  throwIfError(result.error, `mark ${role} email verified`)

  result = await client.from('user_profiles').update({
    display_name: displayName,
    first_name: firstName,
    last_name: lastName,
    username,
    country,
    city,
    base_currency: 'USD',
    timezone: 'Africa/Lagos',
  }).eq('user_id', userId)
  throwIfError(result.error, `update synthetic ${role} profile`)

  result = await client.rpc('register_social_profile')
  throwIfError(result.error, `register synthetic ${role} social profile`)
  result = await client.rpc('set_social_profile_access', { p_access_mode: 'open' })
  throwIfError(result.error, `set synthetic ${role} social access`)
  result = await client.rpc('set_social_trade_history_sharing', { p_enabled: shareHistory })
  throwIfError(result.error, `set synthetic ${role} trade-history consent`)
}

async function ensureSyntheticSubscription(admin, projectRef, userId, role) {
  const id = deterministicUuid(projectRef, `${role}-subscription`)
  const marker = `cus_${SEED_ID.replaceAll('-', '_')}_${projectRef}_${role}`
  const { data: existing, error: readError } = await admin.from('subscriptions')
    .select('id,user_id,stripe_customer_id').eq('user_id', userId).maybeSingle()
  throwIfError(readError, `read synthetic ${role} entitlement`)
  if (existing && (existing.id !== id || existing.stripe_customer_id !== marker)) {
    throw new Error(`Synthetic ${role} user has an unrelated subscription row; refusing to overwrite it`)
  }
  const { error } = await admin.from('subscriptions').upsert({
    id,
    user_id: userId,
    stripe_customer_id: marker,
    stripe_subscription_id: null,
    plan: 'basic',
    status: 'active',
    extra_accounts: 0,
  }, { onConflict: 'user_id' })
  throwIfError(error, `upsert synthetic ${role} entitlement`)
}

async function ensureBrokerAccount(admin, projectRef, userId, role) {
  const id = deterministicUuid(projectRef, `${role}-broker`)
  const accountId = deterministicUuid(projectRef, `${role}-fxsocket-account`)
  const isProvider = role.startsWith('provider')
  const label = role === 'provider'
    ? `[${SEED_ID}] Provider Demo Source`
    : isProvider
      ? `[${SEED_ID}] ${role} Demo Source`
      : `[${SEED_ID}] Viewer Demo Destination`
  const { data: existing, error: readError } = await admin.from('broker_accounts')
    .select('id,user_id,label,fxsocket_account_id').eq('id', id).maybeSingle()
  throwIfError(readError, `read synthetic ${role} broker account`)
  if (existing && (
    existing.user_id !== userId
    || existing.label !== label
    || existing.fxsocket_account_id !== accountId
  )) {
    throw new Error(`Deterministic ${role} broker id is occupied by an unrelated record`)
  }

  const { data: accountCollision, error: collisionError } = await admin.from('broker_accounts')
    .select('id,user_id').eq('user_id', userId).eq('fxsocket_account_id', accountId).maybeSingle()
  throwIfError(collisionError, `check synthetic ${role} broker account marker`)
  if (accountCollision && accountCollision.id !== id) {
    throw new Error(`Synthetic ${role} broker marker is attached to a different record`)
  }

  const now = new Date().toISOString()
  const { error } = await admin.from('broker_accounts').upsert({
    id,
    user_id: userId,
    label,
    platform: 'MT5',
    metaapi_account_id: '',
    fxsocket_account_id: accountId,
    fxsocket_status: 'connected',
    provider: 'fxsocket',
    account_login: isProvider ? String(91_000_001 + Number(role.split('-')[1] ?? 0)) : '91000099',
    broker_name: 'Synthetic Demo Broker',
    broker_server: 'TSCopier-Personal-Seed-Demo',
    connection_status: 'connected',
    linked_account_type: 'Demo',
    last_currency: 'USD',
    last_synced_at: now,
    terminal_connected: true,
    trade_allowed: false,
    is_active: true,
  }, { onConflict: 'id' })
  throwIfError(error, `upsert synthetic ${role} broker account`)
  return id
}

function syntheticTrades(projectRef, providerUserId, brokerAccountId, seedKey, profitScale = 1) {
  const now = Date.now()
  const symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'AUDUSD', 'EURJPY', 'GBPJPY', 'NZDUSD', 'USDCAD', 'EURGBP']
  return TRADE_PROFITS.map((baseProfit, index) => {
    const profit = Math.round(baseProfit * profitScale * 100) / 100
    const daysAgo = 10 - index
    const openedAt = new Date(now - daysAgo * 86_400_000)
    const closedAt = new Date(openedAt.getTime() + (60 + index * 7) * 60_000)
    return {
      id: deterministicUuid(projectRef, `${seedKey}-trade-${index + 1}`),
      user_id: providerUserId,
      broker_account_id: brokerAccountId,
      metaapi_order_id: `${SEED_ID}:${projectRef}${seedKey === 'provider' ? '' : `:${seedKey}`}:ticket-${String(index + 1).padStart(2, '0')}`,
      symbol: symbols[index],
      direction: index % 3 === 1 ? 'sell' : 'buy',
      entry_price: 1 + index / 100,
      lot_size: 0.05 + index / 100,
      status: 'closed',
      opened_at: openedAt.toISOString(),
      closed_at: closedAt.toISOString(),
      profit,
      close_price: 1 + index / 100 + (profit > 0 ? 0.001 : -0.001),
    }
  })
}

async function ensureTrades(admin, projectRef, providerUserId, brokerAccountId, seedKey, profitScale) {
  const rows = syntheticTrades(projectRef, providerUserId, brokerAccountId, seedKey, profitScale)
  const ids = rows.map(row => row.id)
  const tickets = rows.map(row => row.metaapi_order_id)
  const { data: existing, error: readError } = await admin.from('trades')
    .select('id,user_id,broker_account_id,metaapi_order_id').in('id', ids)
  throwIfError(readError, 'read synthetic provider trades')
  for (const row of existing ?? []) {
    const expected = rows.find(item => item.id === row.id)
    if (!expected || row.user_id !== providerUserId || row.broker_account_id !== brokerAccountId || row.metaapi_order_id !== expected.metaapi_order_id) {
      throw new Error(`Deterministic trade id ${row.id} is occupied by an unrelated record`)
    }
  }
  const { data: ticketCollisions, error: ticketError } = await admin.from('trades')
    .select('id,broker_account_id,metaapi_order_id').eq('broker_account_id', brokerAccountId).in('metaapi_order_id', tickets)
  throwIfError(ticketError, 'check synthetic provider trade tickets')
  for (const row of ticketCollisions ?? []) {
    const expected = rows.find(item => item.metaapi_order_id === row.metaapi_order_id)
    if (!expected || row.id !== expected.id) throw new Error(`Synthetic broker ticket ${row.metaapi_order_id} belongs to another trade`)
  }
  const { error } = await admin.from('trades').upsert(rows, { onConflict: 'id' })
  throwIfError(error, 'upsert synthetic provider trades')
}

function uniqueRowsById(rows) {
  return [...new Map(rows.map(row => [row.id, row])).values()]
}

async function loadPublicationState(admin, providerUserId, viewerUserId, brokerAccountId, sourceId) {
  const sourceColumns = 'id,trader_user_id,broker_account_id,status,label'
  const [ownedResult, idResult, brokerResult, actorSubscriptionsResult] = await Promise.all([
    admin.from('social_copy_sources').select(sourceColumns).eq('trader_user_id', providerUserId),
    admin.from('social_copy_sources').select(sourceColumns).eq('id', sourceId),
    admin.from('social_copy_sources').select(sourceColumns).eq('broker_account_id', brokerAccountId),
    admin.from('social_copy_subscriptions')
      .select('id,source_id,source_trader_user_id,subscriber_user_id,status,desired_status')
      .or(`source_trader_user_id.eq.${providerUserId},subscriber_user_id.eq.${viewerUserId}`),
  ])
  throwIfError(ownedResult.error, 'read provider copy sources for publication preflight')
  throwIfError(idResult.error, 'check deterministic copy source id')
  throwIfError(brokerResult.error, 'check synthetic broker copy source')
  throwIfError(actorSubscriptionsResult.error, 'read synthetic-user copy subscriptions for publication preflight')

  const providerSources = ownedResult.data ?? []
  let attachedSubscriptions = []
  if (providerSources.length > 0) {
    const { data, error } = await admin.from('social_copy_subscriptions')
      .select('id,source_id,source_trader_user_id,subscriber_user_id,status,desired_status')
      .in('source_id', providerSources.map(source => source.id))
    throwIfError(error, 'read subscriptions attached to provider sources')
    attachedSubscriptions = data ?? []
  }

  return {
    sources: uniqueRowsById([
      ...providerSources,
      ...(idResult.data ?? []),
      ...(brokerResult.data ?? []),
    ]),
    subscriptions: uniqueRowsById([
      ...(actorSubscriptionsResult.data ?? []),
      ...attachedSubscriptions,
    ]),
  }
}

export function assertSafePublicationState(state, expected, { requireSource = false, requirePublished = false } = {}) {
  if (state.subscriptions.length > 0) {
    throw new Error('Related Social Copy subscriptions exist; refusing to publish because the RPC could modify them')
  }
  if (state.sources.length > 1) {
    throw new Error('Unexpected additional provider copy sources exist; refusing to publish')
  }
  const source = state.sources[0] ?? null
  if (!source) {
    if (requireSource) throw new Error('Deterministic synthetic copy source is missing')
    return null
  }
  if (
    source.id !== expected.sourceId
    || source.trader_user_id !== expected.providerUserId
    || source.broker_account_id !== expected.brokerAccountId
    || source.label !== SOURCE_LABEL
    || !['paused', 'published'].includes(source.status)
  ) {
    throw new Error('Existing copy source is not the exact seed-owned deterministic source')
  }
  if (requirePublished && source.status !== 'published') {
    throw new Error('Deterministic synthetic copy source was not published')
  }
  return source
}

export async function executePublicationLifecycle({ loadState, validateState, stageSource, publishSource }) {
  let state = await loadState()
  let source = validateState(state)
  if (!source) {
    await stageSource()
    state = await loadState()
    source = validateState(state, { requireSource: true })
  }
  if (source.status !== 'published') {
    // This second read is deliberately adjacent to the actor-scoped RPC. The
    // staged source is paused, so supported application flows cannot subscribe
    // to it between staging and publication.
    state = await loadState()
    validateState(state, { requireSource: true })
    await publishSource()
  }
  state = await loadState()
  validateState(state, { requireSource: true, requirePublished: true })
}

async function ensurePublishedSyntheticSource(admin, providerClient, {
  providerUserId,
  viewerUserId,
  brokerAccountId,
  sourceId,
}) {
  const expected = { providerUserId, brokerAccountId, sourceId }
  const loadState = () => loadPublicationState(admin, providerUserId, viewerUserId, brokerAccountId, sourceId)
  const validateState = (state, options) => assertSafePublicationState(state, expected, options)
  await executePublicationLifecycle({
    loadState,
    validateState,
    stageSource: async () => {
      const { error } = await admin.from('social_copy_sources').insert({
        id: sourceId,
        trader_user_id: providerUserId,
        broker_account_id: brokerAccountId,
        status: 'paused',
        label: SOURCE_LABEL,
      })
      throwIfError(error, 'stage deterministic synthetic copy source')
    },
    publishSource: async () => {
      const result = await providerClient.rpc('publish_social_copy_source', {
        p_broker_account_id: brokerAccountId,
        p_label: SOURCE_LABEL,
      })
      throwIfError(result.error, 'publish synthetic provider source')
      if (result.data !== sourceId) throw new Error('Publication RPC returned an unexpected source id')
    },
  })
}

async function main() {
  const url = requiredEnv('SOCIAL_PERSONAL_SUPABASE_URL')
  const configuredRef = requiredEnv('SOCIAL_PERSONAL_PROJECT_REF').toLowerCase()
  const serviceRoleKey = requiredEnv('SOCIAL_PERSONAL_SERVICE_ROLE_KEY')
  const anonKey = requiredEnv('SOCIAL_PERSONAL_ANON_KEY')
  const password = requiredEnv('SOCIAL_PERSONAL_TEST_PASSWORD')
  if (password.length < 12) throw new Error('SOCIAL_PERSONAL_TEST_PASSWORD must contain at least 12 characters')

  const urlRef = projectRefFromUrl(url)
  if (urlRef !== configuredRef) throw new Error('Configured personal project reference does not match the Supabase URL')
  if (SHARED_PROJECT_REFS.has(configuredRef)) throw new Error('Refusing to seed a known shared Supabase project')
  if (!/^[a-z0-9]{20}$/.test(configuredRef)) throw new Error('SOCIAL_PERSONAL_PROJECT_REF has an unexpected format')

  await confirmProject(configuredRef)

  const providerDefinitions = [
    { role: 'provider', emailPrefix: 'provider', displayName: 'Parker Seed Provider', firstName: 'Parker', lastName: 'Seed', country: 'Nigeria', city: 'Lagos', profitScale: 1.00 },
    { role: 'provider-2', emailPrefix: 'provider2', displayName: 'Amara Seed Provider', firstName: 'Amara', lastName: 'Seed', country: 'Ghana', city: 'Accra', profitScale: 0.82 },
    { role: 'provider-3', emailPrefix: 'provider3', displayName: 'Leo Seed Provider', firstName: 'Leo', lastName: 'Seed', country: 'Sweden', city: 'Stockholm', profitScale: 1.18 },
    { role: 'provider-4', emailPrefix: 'provider4', displayName: 'Nora Seed Provider', firstName: 'Nora', lastName: 'Seed', country: 'Nigeria', city: 'Enugu', profitScale: 0.66 },
    { role: 'provider-5', emailPrefix: 'provider5', displayName: 'Kenji Seed Provider', firstName: 'Kenji', lastName: 'Seed', country: 'Japan', city: 'Tokyo', profitScale: 1.35 },
    { role: 'provider-6', emailPrefix: 'provider6', displayName: 'Sofia Seed Provider', firstName: 'Sofia', lastName: 'Seed', country: 'Portugal', city: 'Lisbon', profitScale: 0.94 },
    { role: 'provider-7', emailPrefix: 'provider7', displayName: 'Mateo Seed Provider', firstName: 'Mateo', lastName: 'Seed', country: 'Mexico', city: 'Monterrey', profitScale: 1.08 },
    { role: 'provider-8', emailPrefix: 'provider8', displayName: 'Aisha Seed Provider', firstName: 'Aisha', lastName: 'Seed', country: 'United Arab Emirates', city: 'Dubai', profitScale: 0.74 },
  ].map((provider, index) => ({
    ...provider,
    email: `${provider.emailPrefix}@${configuredRef}.tscopier-seed.example.com`,
    username: `seed_trader_${index + 1}_${configuredRef.slice(0, 6)}`,
  }))
  const viewerEmail = `viewer@${configuredRef}.tscopier-seed.example.com`
  const viewerUsername = `seed_viewer_${configuredRef.slice(0, 8)}`
  const admin = createClient(url, serviceRoleKey, clientOptions())
  let stage = 'initialize'

  try {
    stage = 'preflight Auth ownership before mutation'
    const providerPreflight = []
    for (const definition of providerDefinitions) {
      const existingUser = await findAuthUserByEmail(admin, definition.email)
      if (existingUser) assertOwnedAuthUser(existingUser, configuredRef, definition.role, definition.email)
      providerPreflight.push({ definition, existingUser })
    }
    const existingViewer = await findAuthUserByEmail(admin, viewerEmail)
    if (existingViewer) assertOwnedAuthUser(existingViewer, configuredRef, 'viewer', viewerEmail)

    stage = 'create or refresh synthetic Auth users through the admin API'
    const providers = []
    for (const item of providerPreflight) {
      const user = await ensureAuthUser(admin, {
        existingUser: item.existingUser,
        email: item.definition.email,
        password,
        projectRef: configuredRef,
        role: item.definition.role,
        displayName: item.definition.displayName,
      })
      providers.push({ ...item.definition, user })
    }
    const viewer = await ensureAuthUser(admin, {
      existingUser: existingViewer,
      email: viewerEmail,
      password,
      projectRef: configuredRef,
      role: 'viewer',
      displayName: 'Vivian Seed Viewer',
    })

    stage = 'wait for Auth profile triggers'
    for (const provider of providers) await waitForProfile(admin, provider.user.id, provider.role)
    await waitForProfile(admin, viewer.id, 'viewer')

    stage = 'authenticate synthetic users'
    for (const provider of providers) {
      provider.client = await signIn(url, anonKey, provider.email, password, provider.role)
    }
    const viewerClient = await signIn(url, anonKey, viewerEmail, password, 'viewer')

    stage = 'configure verified social identities and consent'
    for (const provider of providers) {
      await configureActor(provider.client, {
        userId: provider.user.id,
        role: provider.role,
        displayName: provider.displayName,
        firstName: provider.firstName,
        lastName: provider.lastName,
        username: provider.username,
        country: provider.country,
        city: provider.city,
        shareHistory: true,
      })
      const { error } = await admin.from('social_profiles').update({
        is_synthetic_demo: true,
        monthly_copy_price_cents: 0,
      }).eq('user_id', provider.user.id)
      throwIfError(error, `mark ${provider.role} as a synthetic non-copyable demo`)
    }
    await configureActor(viewerClient, {
      userId: viewer.id,
      role: 'viewer',
      displayName: 'Vivian Seed Viewer',
      firstName: 'Vivian',
      lastName: 'Seed',
      username: viewerUsername,
      country: 'Nigeria',
      city: 'Abuja',
      shareHistory: false,
    })

    stage = 'create synthetic plan-limit prerequisites and demo accounts'
    for (const provider of providers) {
      await ensureSyntheticSubscription(admin, configuredRef, provider.user.id, provider.role)
      provider.brokerAccountId = await ensureBrokerAccount(admin, configuredRef, provider.user.id, provider.role)
      provider.sourceId = deterministicUuid(configuredRef, `${provider.role}-social-copy-source`)
    }
    await ensureSyntheticSubscription(admin, configuredRef, viewer.id, 'viewer')
    await ensureBrokerAccount(admin, configuredRef, viewer.id, 'viewer')

    stage = 'create internally consistent closed-trade histories'
    for (const provider of providers) {
      await ensureTrades(admin, configuredRef, provider.user.id, provider.brokerAccountId, provider.role, provider.profitScale)
    }

    stage = 'preflight and publish deterministic provider sources through authenticated RPCs'
    for (const provider of providers) {
      await ensurePublishedSyntheticSource(admin, provider.client, {
        providerUserId: provider.user.id,
        viewerUserId: viewer.id,
        brokerAccountId: provider.brokerAccountId,
        sourceId: provider.sourceId,
      })
    }

    stage = 'establish follows and reviews through authenticated RPCs'
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index]
      let result = await viewerClient.rpc('follow_social_profile', { p_profile_user_id: provider.user.id })
      throwIfError(result.error, `follow ${provider.role}`)
      if (result.data !== 'accepted') throw new Error(`Expected open-profile follow to be accepted for ${provider.role}, received ${String(result.data)}`)
      result = await viewerClient.rpc('upsert_social_trader_review', {
        p_trader_user_id: provider.user.id,
        p_rating: 5 - (index % 3),
        p_review_text: `Synthetic personal-project review for ${provider.displayName}.`,
      })
      throwIfError(result.error, `review ${provider.role}`)
    }

    stage = 'confirm no copy subscriptions were created'
    const providerIds = providers.map(provider => provider.user.id)
    const { count, error } = await admin.from('social_copy_subscriptions')
      .select('id', { count: 'exact', head: true })
      .or(`subscriber_user_id.eq.${viewer.id},source_trader_user_id.in.(${providerIds.join(',')})`)
    throwIfError(error, 'check social copy subscription exclusion')
    if ((count ?? 0) !== 0) {
      throw new Error('Synthetic users already have a social-copy subscription; seed did not create it, but the safety invariant is no longer clean')
    }

    console.log(`Personal Social Trading seed completed for project ${configuredRef}.`)
    console.log('Created or refreshed eight seed-owned demo traders, one viewer, nine demo accounts, 80 closed trades, eight published-but-non-copyable sources, eight follows, and eight reviews.')
    console.log(`Parker expected realized P/L: ${EXPECTED_PROFIT} USD. No social-copy subscription or execution record was created.`)  } catch (error) {
    throw new Error(`Seed failed during stage "${stage}": ${errorMessage(error, [serviceRoleKey, anonKey, password])}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(errorMessage(error, [
      process.env.SOCIAL_PERSONAL_SERVICE_ROLE_KEY,
      process.env.SOCIAL_PERSONAL_ANON_KEY,
      process.env.SOCIAL_PERSONAL_TEST_PASSWORD,
    ]))
    process.exitCode = 1
  })
}
